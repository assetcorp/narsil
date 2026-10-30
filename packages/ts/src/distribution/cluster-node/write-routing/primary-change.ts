import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { getClusterIndexConfig } from '../../cluster/index-metadata'
import { pause } from '../../cluster/rebalance/pause'
import type { AllocationTable } from '../../coordinator/types'
import type { WriteCondition } from '../../transport/types'
import {
  FORWARD_RETRY_DELAY_CAP_MS,
  FORWARD_RETRY_INITIAL_DELAY_MS,
  PARTITION_WRITE_CONCURRENCY,
  PRIMARY_CHANGE_POLL_INTERVAL_MS,
  PRIMARY_CHANGE_RETRY_WINDOW_MS,
} from '../constants'
import { forwardInterrupted, forwardUnsent } from '../transport-failure'
import { abandonedWriteOf, conditionOf } from './abandoned-write'
import { resolvePartitionId } from './assignment'
import { beforeWindowEnds, interruptedOutcome, WINDOW_ENDED, windowEndedOutcome } from './forward-window'
import { abandonedWithTerm } from './rollback'
import { storedCopyMatchesSent } from './sent-fields'
import type { WriteRoutingDeps } from './types'

interface RefusingPrimary {
  partitionCount: number
  partitionId: number
  primary: string | null
  primaryTerm: number
}

export interface RetriedFailure {
  docId: string
  error: unknown
}

export type SettleRetried = (failures: RetriedFailure[]) => Promise<ReadonlySet<string>>

interface RefusedItem<T> {
  item: T
  failure: BatchResult['failed'][number]
  refusing: RefusingPrimary
}

function refusedByPrimaryChange(error: unknown, retriesEndedTerm = false): boolean {
  if (error instanceof NarsilError && error.code === ErrorCodes.PARTITION_NOT_PRIMARY) return true
  return abandonedWithTerm(error) && (retriesEndedTerm || abandonedWriteOf(error) !== undefined)
}

function nextCondition(error: unknown, current: WriteCondition | undefined): WriteCondition | undefined {
  const abandoned = abandonedWriteOf(error)
  return abandoned === undefined ? current : conditionOf(abandoned)
}

function refusedForAnotherIndex(error: unknown): boolean {
  return (
    refusedByPrimaryChange(error) && error instanceof NarsilError && typeof error.details.heldIndexUuid === 'string'
  )
}

function retriedAfterDelay(error: unknown): boolean {
  return refusedForAnotherIndex(error) || forwardUnsent(error) || forwardInterrupted(error)
}

function retriable(error: unknown, settlesAsEqual: boolean): boolean {
  return (
    refusedByPrimaryChange(error, settlesAsEqual) ||
    forwardUnsent(error) ||
    (settlesAsEqual && forwardInterrupted(error))
  )
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof NarsilError && error.code === code
}

function primaryFor(table: AllocationTable | null, docId: string): RefusingPrimary | null {
  if (table === null || table.assignments.size === 0) return null
  const partitionId = resolvePartitionId(docId, table.assignments.size)
  const assignment = table.assignments.get(partitionId)
  return {
    partitionCount: table.assignments.size,
    partitionId,
    primary: assignment?.primary ?? null,
    primaryTerm: assignment?.primaryTerm ?? 0,
  }
}

function movedOn(table: AllocationTable, refusing: RefusingPrimary): boolean {
  if (table.assignments.size !== refusing.partitionCount) return true
  const assignment = table.assignments.get(refusing.partitionId)
  if (assignment === undefined || assignment.primary === null) return false
  return assignment.primary !== refusing.primary || assignment.primaryTerm > refusing.primaryTerm
}

async function liveTable(deps: WriteRoutingDeps, indexName: string): Promise<AllocationTable | null> {
  return deps.refreshAllocation !== undefined
    ? deps.refreshAllocation(indexName)
    : deps.coordinator.getAllocation(indexName)
}

async function pauseAndRereadTable(
  deps: WriteRoutingDeps,
  indexName: string,
  delayMs: number,
  deadline: number,
): Promise<boolean> {
  if (Date.now() >= deadline) return false
  await pause(Math.min(delayMs, deadline - Date.now()))
  try {
    if ((await liveTable(deps, indexName)) === null) return false
  } catch (_) {}
  return true
}

function nextRetryDelay(delayMs: number): number {
  return Math.min(delayMs * 2, FORWARD_RETRY_DELAY_CAP_MS)
}

async function awaitNewPrimary(
  deps: WriteRoutingDeps,
  indexName: string,
  refusing: RefusingPrimary[],
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    let table: AllocationTable | null | undefined
    try {
      table = await liveTable(deps, indexName)
    } catch (_) {
      table = undefined
    }
    if (table === null) return false
    if (table !== undefined && refusing.some(primary => movedOn(table, primary))) return true
    await pause(Math.max(0, Math.min(PRIMARY_CHANGE_POLL_INTERVAL_MS, deadline - Date.now())))
  }
  return false
}

export async function retryOnPrimaryChange<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  docId: string,
  attempt: (condition: WriteCondition | undefined) => Promise<T>,
  settleRetried: SettleRetried,
  settledValue: () => T,
  settlesAsEqual = false,
): Promise<T> {
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  let retryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS
  let retried = false
  let interrupted = false
  let condition: WriteCondition | undefined
  const finalError = (error: unknown): unknown => (interrupted ? interruptedOutcome(indexName, docId, error) : error)
  for (;;) {
    const refusing = primaryFor(await deps.coordinator.getAllocation(indexName), docId)
    let outcome: T | typeof WINDOW_ENDED
    try {
      outcome = await beforeWindowEnds(attempt(condition), deadline)
    } catch (error) {
      if (retried && (await settleRetried([{ docId, error }])).has(docId)) return settledValue()
      interrupted ||= forwardInterrupted(error)
      if (!retriable(error, settlesAsEqual) || refusing === null) throw finalError(error)
      let retryable: boolean
      if (retriedAfterDelay(error)) {
        retryable = await pauseAndRereadTable(deps, indexName, retryDelayMs, deadline)
        retryDelayMs = nextRetryDelay(retryDelayMs)
      } else {
        retryable = await awaitNewPrimary(deps, indexName, [refusing], deadline)
      }
      if (!retryable) throw finalError(error)
      condition = nextCondition(error, condition)
      retried = true
      continue
    }
    if (outcome === WINDOW_ENDED) throw windowEndedOutcome(indexName, docId)
    return outcome
  }
}

async function retryBatchOnPrimaryChange<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  items: readonly T[],
  docIdOf: (item: T) => string,
  attempt: BatchAttempt<T>,
  settleRetried: SettleRetried,
  deadline: number,
  settlesAsEqual: boolean,
): Promise<BatchResult> {
  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const conditions = new Map<string, WriteCondition>()
  const interrupted = new Set<string>()
  const failWith = (failure: BatchResult['failed'][number]): void => {
    failed.push(
      interrupted.has(failure.docId)
        ? { docId: failure.docId, error: interruptedOutcome(indexName, failure.docId, failure.error) }
        : failure,
    )
  }
  let pending = [...items]
  let retryDelayMs = FORWARD_RETRY_INITIAL_DELAY_MS
  let retried = false
  while (pending.length > 0) {
    const table = await deps.coordinator.getAllocation(indexName)
    const result = await beforeWindowEnds(attempt(pending, conditions), deadline)
    if (result === WINDOW_ENDED) {
      for (const item of pending)
        failed.push({ docId: docIdOf(item), error: windowEndedOutcome(indexName, docIdOf(item)) })
      break
    }
    succeeded.push(...result.succeeded)
    const settled = retried ? await settleRetried(result.failed) : new Set<string>()
    const pendingById = new Map(pending.map(item => [docIdOf(item), item]))
    const refused: RefusedItem<T>[] = []
    for (const failure of result.failed) {
      if (settled.has(failure.docId)) {
        succeeded.push(failure.docId)
        continue
      }
      const item = pendingById.get(failure.docId)
      const refusing = primaryFor(table, failure.docId)
      if (forwardInterrupted(failure.error)) interrupted.add(failure.docId)
      if (item === undefined || refusing === null || !retriable(failure.error, settlesAsEqual)) {
        failWith(failure)
        continue
      }
      refused.push({ item, failure, refusing })
    }
    if (refused.length === 0) break
    let retryable: boolean
    if (refused.some(entry => retriedAfterDelay(entry.failure.error))) {
      retryable = await pauseAndRereadTable(deps, indexName, retryDelayMs, deadline)
      retryDelayMs = nextRetryDelay(retryDelayMs)
    } else {
      retryable = await awaitNewPrimary(
        deps,
        indexName,
        refused.map(entry => entry.refusing),
        deadline,
      )
    }
    if (!retryable) {
      for (const entry of refused) failWith(entry.failure)
      break
    }
    for (const { failure } of refused) {
      const condition = nextCondition(failure.error, conditions.get(failure.docId))
      if (condition !== undefined) conditions.set(failure.docId, condition)
    }
    pending = refused.map(entry => entry.item)
    retried = true
  }
  return { succeeded, failed }
}

function groupByPartition<T>(table: AllocationTable, items: readonly T[], docIdOf: (item: T) => string): T[][] {
  const partitionCount = table.assignments.size
  const groups = new Map<number, T[]>()
  for (const item of items) {
    const partitionId = partitionCount === 0 ? 0 : resolvePartitionId(docIdOf(item), partitionCount)
    const group = groups.get(partitionId)
    if (group === undefined) groups.set(partitionId, [item])
    else group.push(item)
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

export type BatchAttempt<T> = (items: T[], conditions: ReadonlyMap<string, WriteCondition>) => Promise<BatchResult>

export async function retryEachPartition<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  table: AllocationTable,
  items: readonly T[],
  docIdOf: (item: T) => string,
  attempt: BatchAttempt<T>,
  settleRetried: SettleRetried,
  settlesAsEqual = false,
): Promise<BatchResult> {
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  const outcomes = await settleEachBounded(
    groupByPartition(table, items, docIdOf),
    PARTITION_WRITE_CONCURRENCY,
    group =>
      retryBatchOnPrimaryChange(deps, indexName, group, docIdOf, attempt, settleRetried, deadline, settlesAsEqual),
  )
  const merged: BatchResult = { succeeded: [], failed: [] }
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason
    merged.succeeded.push(...outcome.value.succeeded)
    merged.failed.push(...outcome.value.failed)
  }
  return merged
}

export const settleNothing: SettleRetried = async () => new Set()

async function derivedFieldsOf(deps: WriteRoutingDeps, indexName: string): Promise<Set<string>> {
  const schema = await deps.coordinator.getSchema(indexName)
  if (schema === null) return new Set()
  const config = await getClusterIndexConfig(deps.coordinator, indexName, schema)
  return new Set(Object.keys(config.embedding?.fields ?? {}))
}

export function settleEqualInserts(
  deps: WriteRoutingDeps,
  indexName: string,
  sentById: ReadonlyMap<string, AnyDocument>,
): SettleRetried {
  return async failures => {
    const existing = failures
      .filter(failure => hasCode(failure.error, ErrorCodes.DOC_ALREADY_EXISTS) && sentById.has(failure.docId))
      .map(failure => failure.docId)
    if (existing.length === 0 || deps.readPrimaryCopies === undefined) return new Set()
    let stored: Map<string, AnyDocument>
    let derivedFields: Set<string>
    try {
      stored = await deps.readPrimaryCopies(indexName, existing)
      derivedFields = await derivedFieldsOf(deps, indexName)
    } catch (_) {
      return new Set()
    }
    const settled = new Set<string>()
    for (const docId of existing) {
      const sent = sentById.get(docId)
      const copy = stored.get(docId)
      if (sent === undefined || copy === undefined) continue
      const derived = copy.id === docId && sent.id === undefined ? new Set([...derivedFields, 'id']) : derivedFields
      if (storedCopyMatchesSent(sent, copy, derived)) settled.add(docId)
    }
    return settled
  }
}
