import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AllocationTable, RegistrationLease } from '../../coordinator/types'
import { REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS, REGISTRATION_LEASE_DRIFT_SHARE } from '../constants'
import { noteLedTerm } from '../led-term'
import { assertReshardOpen } from '../reshard/block'
import type { PrimaryWriteScope } from './numbered-write'
import { enqueuePartitionWrite } from './partition-queue'
import type { WriteRoutingDeps } from './types'

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

function copyFailedIn(scope: PrimaryWriteScope): boolean {
  return scope.deps.copyFailed?.(scope.indexName, scope.partitionId) === true
}

function refuseFromFailedCopy(scope: PrimaryWriteScope, failed: BatchResult['failed']): void {
  for (let index = 0; index < failed.length; index++) {
    const failure = failed[index]
    if (failure?.error.code.startsWith('PERSISTENCE_') === true) {
      failed[index] = { docId: failure.docId, error: notPrimary(scope) }
    }
  }
}

function notPrimary(scope: PrimaryWriteScope): NarsilError {
  return new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${scope.deps.nodeId}' no longer leads partition ${scope.partitionId} of index '${scope.indexName}'`,
    { indexName: scope.indexName, partitionId: scope.partitionId, localNodeId: scope.deps.nodeId },
  )
}

async function confirmBatchRefusals(scope: PrimaryWriteScope, failed: BatchResult['failed']): Promise<void> {
  if (!failed.some(failure => refusedFromLocalCopy(failure.error))) return
  if (!(await leadershipUnconfirmed(scope))) return
  for (let index = 0; index < failed.length; index++) {
    const failure = failed[index]
    if (failure !== undefined && refusedFromLocalCopy(failure.error)) {
      failed[index] = { docId: failure.docId, error: notPrimary(scope) }
    }
  }
}

async function currentScope(scope: PrimaryWriteScope): Promise<PrimaryWriteScope> {
  const { indexName, partitionId, deps } = scope
  const table = await deps.coordinator.getAllocation(indexName)
  const assignment = table?.assignments.get(partitionId)
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

export async function inLeadingPartitionQueue<T>(
  scope: PrimaryWriteScope,
  task: (current: PrimaryWriteScope) => Promise<T>,
  failed?: BatchResult['failed'],
): Promise<T> {
  let current = scope
  let result: T
  try {
    result = await enqueuePartitionWrite(
      scope.deps.partitionWriteQueues,
      scope.indexName,
      scope.partitionId,
      async () => {
        current = await currentScope(scope)
        return task(current)
      },
    )
  } catch (error) {
    if (copyFailedIn(current)) throw notPrimary(current)
    if (refusedFromLocalCopy(error) && (await leadershipUnconfirmed(current))) throw notPrimary(current)
    throw error
  }
  if (await registrationLeaseLapsed(current.deps)) throw notPrimary(current)
  if (failed !== undefined && copyFailedIn(current)) refuseFromFailedCopy(current, failed)
  if (failed !== undefined) await confirmBatchRefusals(current, failed)
  return result
}
