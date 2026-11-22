import type { BatchResult } from '../../../../types/results'
import type { AllocationTable } from '../../../coordinator/types'
import {
  FORWARD_RETRY_INITIAL_DELAY_MS,
  PARTITION_WRITE_CONCURRENCY,
  PRIMARY_CHANGE_RETRY_WINDOW_MS,
} from '../../constants'
import { resolvePartitionId } from '../assignment'
import { type BatchOutcome, type BatchWrite, batchResultOf, type WriteFailure } from '../batch-write'
import { beforeWindowEnds, WINDOW_ENDED, windowEndedOutcome } from '../forward-window'
import type { WriteRoutingDeps } from '../types'
import {
  type AttemptHistory,
  emptyHistory,
  finalError,
  nextCondition,
  recordAttempt,
  retriable,
  retriedAfterDelay,
} from './rules'
import { NOTHING_SETTLED, type RetrySettlement, type SettleRetried } from './settlement'
import { awaitNewPrimary, nextRetryDelay, pauseAndRereadTable, primaryFor, type RefusingPrimary } from './wait'

export type BatchAttempt<V> = (writes: BatchWrite<V>[]) => Promise<BatchOutcome<V>>

interface RefusedWrite<V> {
  failure: WriteFailure<V>
  refusing: RefusingPrimary
}

async function settleInSentOrder<V>(
  pending: readonly BatchWrite<V>[],
  outcome: BatchOutcome<V>,
  acknowledged: readonly BatchWrite<V>[],
  histories: ReadonlyMap<BatchWrite<V>, AttemptHistory>,
  settleRetried: SettleRetried<V>,
): Promise<RetrySettlement> {
  const uncertain = new Map<BatchWrite<V>, WriteFailure<V>>()
  for (const failure of outcome.failed) {
    if (histories.get(failure.write)?.mayHaveApplied === true) uncertain.set(failure.write, failure)
  }
  if (uncertain.size === 0) return NOTHING_SETTLED
  const inSentOrder = pending.flatMap(write => uncertain.get(write) ?? [])
  return settleRetried(inSentOrder, new Set(acknowledged.map(write => write.docId)))
}

async function retryBatchOnPrimaryChange<V>(
  deps: WriteRoutingDeps,
  indexName: string,
  writes: BatchWrite<V>[],
  attempt: BatchAttempt<V>,
  settleRetried: SettleRetried<V>,
  deadline: number,
  settlesAsEqual: boolean,
): Promise<BatchOutcome<V>> {
  const succeeded: BatchWrite<V>[] = []
  const failed: WriteFailure<V>[] = []
  const histories = new Map<BatchWrite<V>, AttemptHistory>()
  const failWith = ({ write, error }: WriteFailure<V>): void => {
    failed.push({ write, error: finalError(histories.get(write), indexName, write.docId, error) })
  }
  let pending = writes
  let retryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS
  while (pending.length > 0) {
    const table = await deps.coordinator.getAllocation(indexName)
    const result = await beforeWindowEnds(attempt(pending), deadline)
    if (result === WINDOW_ENDED) {
      for (const write of pending) failed.push({ write, error: windowEndedOutcome(indexName, write.docId) })
      break
    }
    for (const write of result.succeeded) succeeded.push(write)
    const settlement = await settleInSentOrder(pending, result, succeeded, histories, settleRetried)
    const refused = new Map<BatchWrite<V>, RefusedWrite<V>>()
    for (const failure of result.failed) {
      const { write, error, withheld } = failure
      if (settlement.settled.has(write)) {
        succeeded.push(write)
        continue
      }
      let history = histories.get(write)
      if (settlement.unverified.has(write) && history?.abandonedAttempt !== undefined) {
        failWith({ write, error: history.abandonedAttempt })
        continue
      }
      if (withheld !== true) {
        if (history === undefined) {
          history = emptyHistory()
          histories.set(write, history)
        }
        recordAttempt(history, error)
      }
      const refusing = primaryFor(table, write.docId)
      if (refusing === null || !retriable(error, settlesAsEqual)) {
        failWith(failure)
        continue
      }
      refused.set(write, { failure, refusing })
    }
    if (refused.size === 0) break
    const refusals = [...refused.values()]
    let retryable: boolean
    if (refusals.some(({ failure }) => retriedAfterDelay(failure.error))) {
      retryable = await pauseAndRereadTable(deps, indexName, retryDelayMs, deadline)
      retryDelayMs = nextRetryDelay(retryDelayMs)
    } else {
      retryable = await awaitNewPrimary(
        deps,
        indexName,
        refusals.map(({ refusing }) => refusing),
        deadline,
      )
    }
    if (!retryable) {
      for (const { failure } of refusals) failWith(failure)
      break
    }
    for (const { failure } of refusals) {
      if (failure.withheld === true) continue
      const condition = nextCondition(failure.error, failure.write.condition)
      if (condition !== undefined) failure.write.condition = condition
    }
    pending = pending.filter(write => refused.has(write))
  }
  return { succeeded, failed }
}

function groupByPartition<V>(table: AllocationTable, writes: readonly BatchWrite<V>[]): BatchWrite<V>[][] {
  const partitionCount = table.assignments.size
  const groups = new Map<number, BatchWrite<V>[]>()
  for (const write of writes) {
    const partitionId = partitionCount === 0 ? 0 : resolvePartitionId(write.docId, partitionCount)
    const group = groups.get(partitionId)
    if (group === undefined) groups.set(partitionId, [write])
    else group.push(write)
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, group]) => group)
}

async function settleEachBounded<T, R>(
  inputs: readonly T[],
  limit: number,
  run: (input: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const outcomes: PromiseSettledResult<R>[] = []
  const queue = [...inputs.entries()]
  async function work(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [at, input] = next
      try {
        outcomes[at] = { status: 'fulfilled', value: await run(input) }
      } catch (reason) {
        outcomes[at] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, work))
  return outcomes
}

export async function retryEachPartition<V>(
  deps: WriteRoutingDeps,
  indexName: string,
  table: AllocationTable,
  writes: readonly BatchWrite<V>[],
  attempt: BatchAttempt<V>,
  settleRetried: SettleRetried<V>,
  settlesAsEqual = false,
): Promise<BatchResult> {
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  const outcomes = await settleEachBounded(groupByPartition(table, writes), PARTITION_WRITE_CONCURRENCY, group =>
    retryBatchOnPrimaryChange(deps, indexName, group, attempt, settleRetried, deadline, settlesAsEqual),
  )
  const merged: BatchOutcome<V> = { succeeded: [], failed: [] }
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason
    for (const write of outcome.value.succeeded) merged.succeeded.push(write)
    for (const failure of outcome.value.failed) merged.failed.push(failure)
  }
  return batchResultOf(merged)
}
