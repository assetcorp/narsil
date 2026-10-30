import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { pause } from '../../cluster/rebalance/pause'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import { ROLLBACK_RETRY_DELAY_CAP_MS, ROLLBACK_RETRY_INITIAL_DELAY_MS } from '../constants'
import { untilSuperseded } from '../led-term'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { PrimaryWriteScope } from './numbered-write'
import { chunkReplicationEntries, replicateEntryBatch } from './replication'

type RollbackEnd = 'complete' | 'superseded' | 'stopped'

export type OutcomeUnknownReason = 'term_ended' | 'rollback_open' | 'lease_lapsed'

export function outcomeUnknown(
  scope: PrimaryWriteScope,
  originalError: unknown,
  reason: OutcomeUnknownReason,
  because: string,
): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `A write to partition ${scope.partitionId} of index '${scope.indexName}' failed after the primary applied it, and ${because}, so the write may or may not have taken effect. Read the document before you retry the write.`,
    {
      indexName: scope.indexName,
      partitionId: scope.partitionId,
      primaryTerm: scope.assignment.primaryTerm,
      reason,
      originalError: describeError(originalError),
    },
  )
}

export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.REPLICATION_OUTCOME_UNKNOWN
}

export function abandonedWithTerm(error: unknown): boolean {
  return isOutcomeUnknown(error) && error instanceof NarsilError && error.details.reason === 'term_ended'
}

function lostTerm(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.PARTITION_NOT_PRIMARY
}

async function leadingAssignment(scope: PrimaryWriteScope): Promise<PartitionAssignment> {
  const { deps, indexName, partitionId } = scope
  const table =
    deps.refreshAllocation !== undefined
      ? await deps.refreshAllocation(indexName)
      : await deps.coordinator.getAllocation(indexName)
  const assignment = table?.assignments.get(partitionId)
  if (
    assignment !== undefined &&
    assignment.primary === deps.nodeId &&
    assignment.primaryTerm === scope.assignment.primaryTerm &&
    deps.copyFailed?.(indexName, partitionId) !== true
  ) {
    return assignment
  }
  throw new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${deps.nodeId}' no longer leads partition ${partitionId} of index '${indexName}' under term ${scope.assignment.primaryTerm}`,
    {
      indexName,
      partitionId,
      localNodeId: deps.nodeId,
      expectedPrimaryTerm: scope.assignment.primaryTerm,
      currentPrimaryNodeId: assignment?.primary ?? null,
      currentPrimaryTerm: assignment?.primaryTerm ?? null,
    },
  )
}

async function sendRollback(scope: PrimaryWriteScope, entries: ReplicationLogEntry[]): Promise<void> {
  const assignment = await leadingAssignment(scope)
  for (const chunk of chunkReplicationEntries(entries.map(entry => ({ entry })))) {
    await replicateEntryBatch(
      chunk.map(item => item.entry),
      assignment,
      scope.deps,
      scope.indexUuid,
    )
  }
}

async function tryRollback(
  scope: PrimaryWriteScope,
  entries: ReplicationLogEntry[],
  timeoutMs: number,
  delayMs: number,
): Promise<boolean> {
  try {
    await withinDeadline(
      sendRollback(scope, entries),
      timeoutMs,
      () => new Error(`A try to complete a rollback did not finish within ${timeoutMs}ms`),
    )
    return true
  } catch (error) {
    if (lostTerm(error)) throw error
  }
  await pause(delayMs)
  return false
}

async function completeRollback(scope: PrimaryWriteScope, fromSeqNo: number, timeoutMs: number): Promise<RollbackEnd> {
  const log = scope.deps.getReplicationLog(scope.indexName, scope.partitionId)
  let delayMs = ROLLBACK_RETRY_INITIAL_DELAY_MS
  for (;;) {
    if (scope.deps.stopped?.() === true) return 'stopped'
    const entries = log.getEntriesFrom(fromSeqNo)
    const last = entries.at(-1)
    if (last === undefined) return 'superseded'
    try {
      if (await untilSuperseded(log, last, tryRollback(scope, entries, timeoutMs, delayMs))) return 'complete'
    } catch (error) {
      if (lostTerm(error)) return 'superseded'
    }
    delayMs = Math.min(delayMs * 2, ROLLBACK_RETRY_DELAY_CAP_MS)
  }
}

export async function settleRollback(
  scope: PrimaryWriteScope,
  fromSeqNo: number,
  originalError: unknown,
  failedAt: number,
): Promise<unknown> {
  const timeoutMs = replicationTimeoutOf(scope.deps)
  const rollback = completeRollback(scope, fromSeqNo, timeoutMs)
  scope.holdQueue?.(rollback)
  let timer: ReturnType<typeof setTimeout> | undefined
  const stillOpen = new Promise<'open'>(resolve => {
    timer = setTimeout(() => resolve('open'), Math.max(0, failedAt + timeoutMs - Date.now()))
  })
  const end = await Promise.race([rollback, stillOpen]).finally(() => clearTimeout(timer))
  if (end === 'complete') return originalError
  if (end === 'superseded') {
    return outcomeUnknown(
      scope,
      originalError,
      'term_ended',
      'the primary lost its term before every in-sync copy dropped the write',
    )
  }
  const because =
    end === 'stopped'
      ? 'the primary shut down before every in-sync copy dropped the write'
      : `the primary could not confirm within ${timeoutMs}ms that every in-sync copy dropped it`
  return outcomeUnknown(scope, originalError, 'rollback_open', because)
}
