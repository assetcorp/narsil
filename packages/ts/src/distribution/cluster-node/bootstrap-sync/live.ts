import { ErrorCodes, NarsilError } from '../../../errors'
import type { ClusterCoordinator } from '../../coordinator/types'
import {
  ABORT_SENTINEL,
  loadCoordinatorSchema,
  resolveTransportTargets,
  surfaceAborted,
  surfaceError,
} from '../bootstrap-restore'
import { entryKey } from './state'
import { syncFromAnyTarget } from './targets'
import type { AbortCheck, BootstrapEntry, BootstrapSyncState, LiveBootstrapSyncDeps } from './types'

export async function resolveLivePartitionCount(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  abortPromise: Promise<typeof ABORT_SENTINEL>,
): Promise<{ partitionCount: number } | { error: NarsilError } | 'aborted'> {
  try {
    const winner = await Promise.race([coordinator.getAllocation(indexName), abortPromise])
    if (winner === ABORT_SENTINEL) {
      return 'aborted'
    }

    const allocation = winner
    if (allocation === null) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
          `coordinator has no allocation for index '${indexName}'`,
          { indexName, primaryNodeId },
        ),
      }
    }

    const assignment = allocation.assignments.get(partitionId)
    if (assignment === undefined) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
          `No assignment exists for partition ${partitionId} of index '${indexName}'`,
          { indexName, partitionId, primaryNodeId },
        ),
      }
    }

    if (assignment.primary !== primaryNodeId) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
          `Partition ${partitionId} of index '${indexName}' is no longer primary on '${primaryNodeId}'`,
          { indexName, partitionId, primaryNodeId, currentPrimary: assignment.primary },
        ),
      }
    }

    return { partitionCount: allocation.assignments.size }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return {
      error: new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
        `coordinator.getAllocation failed: ${cause}`,
        {
          indexName,
          partitionId,
          primaryNodeId,
          cause,
        },
      ),
    }
  }
}

export async function executeLiveBootstrapSync(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: LiveBootstrapSyncDeps,
  deadlineMs: number,
  deadline: number,
  abortCheck: AbortCheck,
): Promise<boolean> {
  const schemaResult = await loadCoordinatorSchema(deps.coordinator, indexName, primaryNodeId, entry.abortPromise)
  if (schemaResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if ('error' in schemaResult) {
    surfaceError(deps, indexName, primaryNodeId, schemaResult.error)
    return false
  }
  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const allocationResult = await resolveLivePartitionCount(
    deps.coordinator,
    indexName,
    partitionId,
    primaryNodeId,
    entry.abortPromise,
  )
  if (allocationResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if ('error' in allocationResult) {
    surfaceError(deps, indexName, primaryNodeId, allocationResult.error)
    return false
  }

  if (Date.now() >= deadline) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before starting live sync', {
        indexName,
        deadlineMs,
      }),
    )
    return false
  }

  const targetsResult = await resolveTransportTargets(indexName, primaryNodeId, deps.resolveNodeTargets)
  if (targetsResult instanceof NarsilError) {
    surfaceError(deps, indexName, primaryNodeId, targetsResult)
    return false
  }

  const syncResult = await syncFromAnyTarget(
    state,
    entry,
    indexName,
    partitionId,
    primaryNodeId,
    targetsResult,
    schemaResult.schema,
    allocationResult.partitionCount,
    deadline,
    deps,
    abortCheck,
  )

  if (!syncResult.ok) {
    if (syncResult.error.code === ErrorCodes.SNAPSHOT_SYNC_ABORTED) {
      surfaceAborted(deps, indexName, primaryNodeId)
      return false
    }
    if (syncResult.error.details.alreadySurfaced !== true) {
      surfaceError(deps, indexName, primaryNodeId, syncResult.error)
    }
    return false
  }

  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  if (syncResult.snapshotHeader !== null) {
    deps.onSnapshotApplied?.(indexName, partitionId, syncResult.snapshotHeader)
  }
  state.completed.add(entryKey(indexName, partitionId))
  return true
}
