import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { termRefusingSender } from '../led-term'
import type { DataNodeHandlerDeps } from './types'

export type EntryScope = Pick<ReplicationLogEntry, 'indexName' | 'partitionId' | 'primaryTerm'>

function entryRefusal(
  table: AllocationTable | null,
  entry: EntryScope,
  sourceNodeId: string,
  localNodeId: string,
  log: ReplicationLog,
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

  const knownTerm = termRefusingSender(log, assignment.primaryTerm)
  if (knownTerm !== null) {
    return new NarsilError(
      ErrorCodes.REPLICATION_TERM_MISMATCH,
      `Replication entry for index '${entry.indexName}' partition ${entry.partitionId} came from a primary at term ${assignment.primaryTerm}, below the term ${knownTerm} this node already knows`,
      { ...where, sourceNodeId, primaryTerm: assignment.primaryTerm, knownTerm },
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
  entry: EntryScope,
  sourceNodeId: string,
  deps: DataNodeHandlerDeps,
): Promise<PartitionAssignment> {
  const log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
  const refusal = (table: AllocationTable | null) => entryRefusal(table, entry, sourceNodeId, deps.nodeId, log)
  if (deps.allocations === undefined) {
    const live = refusal(await deps.coordinator.getAllocation(entry.indexName))
    if (live instanceof NarsilError) throw live
    return live
  }

  const cached = refusal(await deps.allocations.read(entry.indexName))
  if (!(cached instanceof NarsilError)) return cached
  const live = refusal(await deps.allocations.refresh(entry.indexName))
  if (live instanceof NarsilError) throw live
  return live
}
