import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import type { DataNodeHandlerDeps } from './types'

function entryRefusal(
  table: AllocationTable | null,
  entry: ReplicationLogEntry,
  sourceNodeId: string,
  localNodeId: string,
): NarsilError | PartitionAssignment {
  const where = { indexName: entry.indexName, partitionId: entry.partitionId }
  if (table === null) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `No allocation table is available for replication entry on index '${entry.indexName}'`,
      where,
    )
  }

  const assignment = table.assignments.get(entry.partitionId)
  if (assignment === undefined) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `No assignment exists for replication entry partition ${entry.partitionId} of index '${entry.indexName}'`,
      where,
    )
  }

  if (assignment.primary !== sourceNodeId) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Replication entry for index '${entry.indexName}' partition ${entry.partitionId} came from a non-primary node`,
      { ...where, sourceNodeId, primaryNodeId: assignment.primary },
    )
  }

  if (entry.primaryTerm > assignment.primaryTerm) {
    return new NarsilError(
      ErrorCodes.REPLICATION_TERM_MISMATCH,
      `Replication entry term ${entry.primaryTerm} is newer than allocation term ${assignment.primaryTerm}`,
      where,
    )
  }

  if (!assignment.replicas.includes(localNodeId)) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Node '${localNodeId}' is not an assigned replica for index '${entry.indexName}' partition ${entry.partitionId}`,
      { ...where, nodeId: localNodeId },
    )
  }

  return assignment
}

export async function resolveValidatedAssignment(
  entry: ReplicationLogEntry,
  sourceNodeId: string,
  deps: DataNodeHandlerDeps,
): Promise<PartitionAssignment> {
  if (deps.allocations === undefined) {
    const live = entryRefusal(await deps.coordinator.getAllocation(entry.indexName), entry, sourceNodeId, deps.nodeId)
    if (live instanceof NarsilError) throw live
    return live
  }

  const cached = entryRefusal(await deps.allocations.read(entry.indexName), entry, sourceNodeId, deps.nodeId)
  if (!(cached instanceof NarsilError)) return cached
  const live = entryRefusal(await deps.allocations.refresh(entry.indexName), entry, sourceNodeId, deps.nodeId)
  if (live instanceof NarsilError) throw live
  return live
}
