import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AllocationTable } from '../../coordinator/types'
import { REGISTRATION_LEASE_DRIFT_SHARE } from '../constants'
import { assertReshardOpen } from '../reshard/block'
import type { PrimaryWriteScope } from './numbered-write'
import { enqueuePartitionWrite } from './partition-queue'
import type { WriteRoutingDeps } from './types'

const REFUSALS_FROM_LOCAL_COPY: ReadonlySet<string> = new Set([ErrorCodes.DOC_NOT_FOUND, ErrorCodes.DOC_ALREADY_EXISTS])

function refusedFromLocalCopy(error: unknown): boolean {
  return error instanceof NarsilError && REFUSALS_FROM_LOCAL_COPY.has(error.code)
}

function registrationLeaseLapsed(deps: WriteRoutingDeps): boolean {
  const lease = deps.coordinator.registrationLease?.(deps.nodeId)
  if (lease === undefined) return false
  return lease === null || lease.remainingMs <= lease.ttlMs * REGISTRATION_LEASE_DRIFT_SHARE
}

async function leadershipMoved(scope: PrimaryWriteScope): Promise<boolean> {
  const { deps, indexName, partitionId } = scope
  if (deps.refreshAllocation === undefined) return false
  let live: AllocationTable | null
  try {
    live = await deps.refreshAllocation(indexName)
  } catch (_) {
    return false
  }
  const assignment = live?.assignments.get(partitionId)
  if (assignment === undefined || assignment.primary === null) return false
  return assignment.primary !== deps.nodeId || assignment.primaryTerm > scope.assignment.primaryTerm
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
  if (!(await leadershipMoved(scope))) return
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
  if (assignment === undefined || assignment.primary !== deps.nodeId || registrationLeaseLapsed(deps)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_NOT_PRIMARY,
      `Node '${deps.nodeId}' stopped leading partition ${partitionId} of index '${indexName}' while the write waited`,
      { indexName, partitionId, primaryNodeId: assignment?.primary ?? null, localNodeId: deps.nodeId },
    )
  }
  await assertReshardOpen(deps.reshard, deps.coordinator, indexName, partitionId, assignment.primaryTerm)
  return { ...scope, assignment }
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
    if (refusedFromLocalCopy(error) && (await leadershipMoved(current))) throw notPrimary(current)
    throw error
  }
  if (registrationLeaseLapsed(current.deps)) throw notPrimary(current)
  if (failed !== undefined) await confirmBatchRefusals(current, failed)
  return result
}
