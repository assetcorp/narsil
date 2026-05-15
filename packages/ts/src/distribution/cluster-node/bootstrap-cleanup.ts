import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { ClusterCoordinator } from '../coordinator/types'

export interface BootstrapCleanupDeps {
  engine: Narsil
  coordinator: ClusterCoordinator
  nodeId: string
  onError?: (error: unknown) => void
}

/**
 * When a partition is removed from this node, bring the local engine state in
 * line with the coordinator's view. The engine hosts a single index per
 * indexName irrespective of partition, so the drop is only safe when this
 * node has no other partitions of the same index assigned to it.
 *
 * This operation runs in the background after the synchronous state update in
 * the bootstrap tracker; it never throws to the caller. Errors are reported
 * via onError with a NarsilError envelope.
 */
export async function cleanupRemovedPartition(
  indexName: string,
  partitionId: number,
  deps: BootstrapCleanupDeps,
): Promise<void> {
  try {
    const existing = deps.engine.listIndexes().find(idx => idx.name === indexName)
    if (existing === undefined) {
      return
    }

    if (await nodeHasOtherPartitions(indexName, partitionId, deps)) {
      return
    }

    await deps.engine.dropIndex(indexName)
  } catch (err) {
    if (deps.onError === undefined) {
      return
    }
    if (err instanceof NarsilError && err.code === ErrorCodes.INDEX_NOT_FOUND) {
      return
    }
    const cause = err instanceof Error ? err.message : String(err)
    deps.onError(
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
        `failed to drop local index '${indexName}' after partition removal: ${cause}`,
        { indexName, partitionId, cause },
      ),
    )
  }
}

async function nodeHasOtherPartitions(
  indexName: string,
  removedPartitionId: number,
  deps: BootstrapCleanupDeps,
): Promise<boolean> {
  let allocation: Awaited<ReturnType<ClusterCoordinator['getAllocation']>>
  try {
    allocation = await deps.coordinator.getAllocation(indexName)
  } catch (_) {
    // If the allocation lookup fails, the safest choice is to NOT drop the
    // index: a stale read could cause us to blow away data that another live
    // partition assignment is still serving. The coordinator will re-drive
    // the removal flow when the lookup recovers.
    return true
  }

  if (allocation === null) {
    return false
  }

  for (const [partitionId, assignment] of allocation.assignments) {
    if (partitionId === removedPartitionId) {
      continue
    }
    if (assignment.primary === deps.nodeId) {
      return true
    }
    if (assignment.replicas.includes(deps.nodeId)) {
      return true
    }
  }
  return false
}
