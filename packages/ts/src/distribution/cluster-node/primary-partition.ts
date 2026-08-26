import { ErrorCodes, NarsilError } from '../../errors'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { validateRestoredSchema } from './bootstrap-restore'
import type { ClusterLocalEngine } from './local-engine'

export interface PrimaryPartitionDeps {
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  nodeId: string
  seedReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm: number) => void
  replicationLogPosition: (indexName: string, partitionId: number) => number
  onError: (error: unknown) => void
}

/**
 * Readies this node to take writes for a partition it leads, and reports whether it can.
 *
 * The node creates the index where it holds no copy, and it checks a copy it already holds against the schema the
 * cluster keeps. A node the controller promoted back after every copy of the partition was lost numbers its next
 * entry above everything its own copy already holds, so a replica that returns can still reach the commit point the
 * controller stored.
 *
 * @param indexName - The index the partition belongs to.
 * @param partitionId - The partition this node leads.
 * @param deps - The engine, the coordinator, this node's id, and the replication log this node writes.
 * @returns True where the node can serve the partition as primary.
 */
export async function preparePrimaryPartition(
  indexName: string,
  partitionId: number,
  deps: PrimaryPartitionDeps,
): Promise<boolean> {
  const schema = await deps.coordinator.getSchema(indexName)
  if (schema === null) {
    return false
  }
  const allocation = await deps.coordinator.getAllocation(indexName)
  if (allocation === null || allocation.assignments.size === 0) {
    return false
  }

  const existing = deps.engine.listIndexes().find(index => index.name === indexName)
  if (existing === undefined) {
    try {
      await deps.engine.createIndex(indexName, {
        schema,
        partitions: { maxPartitions: allocation.assignments.size },
      })
    } catch (error) {
      if (!(error instanceof NarsilError) || error.code !== ErrorCodes.INDEX_ALREADY_EXISTS) {
        deps.onError(error)
        return false
      }
    }
  } else {
    const schemaError = validateRestoredSchema(deps.engine, indexName, deps.nodeId, schema)
    if (schemaError !== null) {
      deps.onError(schemaError)
      return false
    }
  }

  resumeNumberingAboveOwnCopy(indexName, partitionId, allocation.assignments.get(partitionId), deps)
  return true
}

function resumeNumberingAboveOwnCopy(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment | undefined,
  deps: PrimaryPartitionDeps,
): void {
  if (assignment === undefined) {
    return
  }
  if (deps.replicationLogPosition(indexName, partitionId) > 0) {
    return
  }
  const floor = Math.max(deps.engine.highestAppliedSeqNoOf(indexName, partitionId), assignment.commitPoint)
  if (floor <= 0) {
    return
  }
  deps.seedReplicationLog(indexName, partitionId, floor + 1, assignment.primaryTerm)
}
