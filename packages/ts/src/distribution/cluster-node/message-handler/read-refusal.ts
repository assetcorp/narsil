import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type { DataNodeHandlerDeps } from './types'

export type ServedRead = 'query' | 'partition-read'

type ReadRefusalDeps = Pick<DataNodeHandlerDeps, 'nodeId' | 'writeDeps'>

interface UnservedPartition {
  partitionId: number
  initialising: boolean
}

function outsideInSyncSet(assignment: PartitionAssignment, nodeId: string): boolean {
  return (
    assignment.primary !== null &&
    assignment.primary !== nodeId &&
    assignment.replicas.includes(nodeId) &&
    !assignment.inSyncSet.includes(nodeId)
  )
}

function unservedPartition(
  table: AllocationTable | null,
  partitionIds: Iterable<number>,
  nodeId: string,
  read: ServedRead,
): UnservedPartition | null {
  if (table === null) return null
  for (const partitionId of partitionIds) {
    const assignment = table.assignments.get(partitionId)
    if (assignment === undefined) continue
    if (assignment.state === 'INITIALISING') return { partitionId, initialising: true }
    if (read === 'query' && outsideInSyncSet(assignment, nodeId)) return { partitionId, initialising: false }
  }
  return null
}

function readRefusal(nodeId: string, indexName: string, unserved: UnservedPartition): NarsilError {
  const { partitionId, initialising } = unserved
  const reason = initialising
    ? `partition ${partitionId} of index '${indexName}' is INITIALISING`
    : `its copy of partition ${partitionId} of index '${indexName}' is outside the in-sync set`
  return new NarsilError(ErrorCodes.QUERY_NO_ACTIVE_REPLICA, `Node '${nodeId}' serves no read, because ${reason}`, {
    indexName,
    partitionId,
    nodeId,
  })
}

async function watchedTable(deps: ReadRefusalDeps, indexName: string): Promise<AllocationTable | null> {
  try {
    return await deps.writeDeps.coordinator.getAllocation(indexName)
  } catch (_) {
    return null
  }
}

export async function refuseUnservedRead(
  deps: ReadRefusalDeps,
  indexName: string,
  partitionIds: readonly number[],
  read: ServedRead,
): Promise<void> {
  const watched = unservedPartition(await watchedTable(deps, indexName), partitionIds, deps.nodeId, read)
  if (watched === null) return
  const { readLiveAllocation, coordinator } = deps.writeDeps
  let live: AllocationTable | null
  try {
    live = await (readLiveAllocation?.(indexName) ?? coordinator.getAllocation(indexName))
  } catch (_) {
    throw readRefusal(deps.nodeId, indexName, watched)
  }
  const confirmed = unservedPartition(live, partitionIds, deps.nodeId, read)
  if (confirmed !== null) throw readRefusal(deps.nodeId, indexName, confirmed)
}
