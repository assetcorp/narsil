import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, PartitionAssignment, RegistrationLease } from '../../coordinator/types'
import { type CatchUpState, partitionKey } from '../catch-up/state'
import { REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS, REGISTRATION_LEASE_DRIFT_SHARE } from '../constants'
import { noteLedTerm } from '../led-term'
import { assertReshardOpen } from '../reshard/block'
import { initialisingHere, liveWritablePartition } from './initialising-partition'
import type { PrimaryWriteScope } from './numbered-write'
import { enqueuePartitionWrite } from './partition-queue'
import { failedCopyOutcome, isOutcomeUnknown, outcomeUnknown } from './rollback'
import { startTermInQueue } from './term-start'
import type { WriteRoutingDeps } from './types'

interface RefusableWrite {
  error: NarsilError
}

const REFUSALS_FROM_LOCAL_COPY: ReadonlySet<string> = new Set([ErrorCodes.DOC_NOT_FOUND, ErrorCodes.DOC_ALREADY_EXISTS])

function refusedFromLocalCopy(error: unknown): boolean {
  return error instanceof NarsilError && REFUSALS_FROM_LOCAL_COPY.has(error.code)
}

function leaseLapsed(lease: RegistrationLease | null): boolean {
  return lease === null || lease.remainingMs <= lease.ttlMs * REGISTRATION_LEASE_DRIFT_SHARE
}

async function confirmedWithin(deps: WriteRoutingDeps): Promise<RegistrationLease | null | undefined> {
  const confirming = deps.coordinator.confirmRegistrationLease?.(deps.nodeId)
  if (confirming === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS)
  })
  try {
    return await Promise.race([confirming.catch(() => null), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

async function registrationLeaseLapsed(deps: WriteRoutingDeps): Promise<boolean> {
  const lease = deps.coordinator.registrationLease?.(deps.nodeId)
  if (lease === undefined || !leaseLapsed(lease)) return false
  const confirmed = await confirmedWithin(deps)
  return confirmed === undefined || leaseLapsed(confirmed)
}

async function leadershipUnconfirmed(scope: PrimaryWriteScope): Promise<boolean> {
  const { deps, indexName, partitionId } = scope
  let live: AllocationTable | null
  try {
    live =
      deps.readLiveAllocation !== undefined
        ? await deps.readLiveAllocation(indexName)
        : await deps.coordinator.getAllocation(indexName)
  } catch (_) {
    return true
  }
  const assignment = live?.assignments.get(partitionId)
  if (assignment === undefined) return true
  return assignment.primary !== deps.nodeId || assignment.primaryTerm > scope.assignment.primaryTerm
}

function logEndOf(scope: PrimaryWriteScope): number {
  return scope.deps.getReplicationLog(scope.indexName, scope.partitionId).localLogEnd
}

function copyFailedIn(scope: PrimaryWriteScope): boolean {
  return scope.deps.copyFailed?.(scope.indexName, scope.partitionId) === true
}

function refuseFromFailedCopy(scope: PrimaryWriteScope, failed: readonly RefusableWrite[]): void {
  for (const failure of failed) {
    if (failure.error.code.startsWith('PERSISTENCE_')) failure.error = notPrimary(scope)
  }
}

function notPrimary(scope: PrimaryWriteScope): NarsilError {
  return new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${scope.deps.nodeId}' no longer leads partition ${scope.partitionId} of index '${scope.indexName}'`,
    { indexName: scope.indexName, partitionId: scope.partitionId, localNodeId: scope.deps.nodeId },
  )
}

async function confirmBatchRefusals(scope: PrimaryWriteScope, failed: readonly RefusableWrite[]): Promise<void> {
  if (!failed.some(failure => refusedFromLocalCopy(failure.error))) return
  if (!(await leadershipUnconfirmed(scope))) return
  for (const failure of failed) {
    if (refusedFromLocalCopy(failure.error)) failure.error = notPrimary(scope)
  }
}

async function currentScope(scope: PrimaryWriteScope): Promise<PrimaryWriteScope> {
  const { indexName, partitionId, deps } = scope
  let table = await deps.coordinator.getAllocation(indexName)
  let assignment = table?.assignments.get(partitionId)
  if (initialisingHere(assignment, deps.nodeId)) {
    const live = await liveWritablePartition(deps, indexName, partitionId)
    table = live.table
    assignment = live.assignment
  }
  const copyFailed = deps.copyFailed?.(indexName, partitionId) === true
  if (
    assignment === undefined ||
    assignment.primary !== deps.nodeId ||
    copyFailed ||
    (await registrationLeaseLapsed(deps))
  ) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' stopped leading partition ${partitionId} of index '${indexName}' while the write waited`,
      { indexName, partitionId, primaryNodeId: assignment?.primary ?? null, localNodeId: deps.nodeId },
    )
  }
  await assertReshardOpen(deps.reshard, deps.coordinator, indexName, partitionId, assignment.primaryTerm)
  noteLedTerm(deps.getReplicationLog(indexName, partitionId), assignment.primaryTerm)
  return { ...scope, assignment, indexUuid: table?.indexUuid }
}

export async function scopeInLeadingQueue(scope: PrimaryWriteScope): Promise<PrimaryWriteScope> {
  return currentScope(scope)
}

export async function inLeadingPartitionQueue<T>(
  scope: PrimaryWriteScope,
  task: (current: PrimaryWriteScope) => Promise<T>,
  failed?: readonly RefusableWrite[],
): Promise<T> {
  let current = scope
  let logEndBefore: number | undefined
  let appendedInTask = false
  let result: T
  try {
    result = await enqueuePartitionWrite(
      scope.deps.partitionWriteQueues,
      scope.indexName,
      scope.partitionId,
      async hold => {
        current = { ...(await currentScope(scope)), holdQueue: hold }
        if (await startTermInQueue(current)) current = { ...(await currentScope(scope)), holdQueue: hold }
        const taskStart = logEndOf(current)
        logEndBefore = taskStart
        try {
          return await task(current)
        } catch (error) {
          appendedInTask = logEndOf(current) !== taskStart
          throw error
        }
      },
    )
  } catch (error) {
    if (isOutcomeUnknown(error)) throw error
    if (copyFailedIn(current)) throw appendedInTask ? failedCopyOutcome(current, error) : notPrimary(current)
    if (refusedFromLocalCopy(error) && (await leadershipUnconfirmed(current))) throw notPrimary(current)
    throw error
  }
  if (await registrationLeaseLapsed(current.deps)) {
    const refusal = notPrimary(current)
    if (logEndBefore === undefined || logEndOf(current) === logEndBefore) throw refusal
    throw outcomeUnknown(
      current,
      refusal,
      'lease_lapsed',
      'its registration lease lapsed before it could acknowledge the write',
    )
  }
  if (failed !== undefined && copyFailedIn(current)) refuseFromFailedCopy(current, failed)
  if (failed !== undefined) await confirmBatchRefusals(current, failed)
  return result
}

const termStartsFromTable = new WeakMap<CatchUpState, Map<string, number>>()

function queuedTermStartsOf(deps: WriteRoutingDeps): Map<string, number> {
  let queued = termStartsFromTable.get(deps.catchUp)
  if (queued === undefined) {
    queued = new Map()
    termStartsFromTable.set(deps.catchUp, queued)
  }
  return queued
}

export function startLeadingTerm(
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
): void {
  const key = partitionKey(indexName, partitionId)
  if ((deps.catchUp.startedTerms.get(key) ?? 0) >= assignment.primaryTerm) return
  const queued = queuedTermStartsOf(deps)
  if ((queued.get(key) ?? 0) >= assignment.primaryTerm) return
  queued.set(key, assignment.primaryTerm)
  inLeadingPartitionQueue({ indexName, partitionId, assignment, deps }, async () => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (queued.get(key) === assignment.primaryTerm) queued.delete(key)
    })
}
