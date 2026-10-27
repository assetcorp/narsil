import type { EngineCore } from '../../engine/core'
import type { PartitionLogPosition } from '../../persistence/durability/types'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationConfig, ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { ClusterLocalEngine } from './local-engine'
import { seedReplicationLog } from './replication-logs'

interface ReopenReplicationInput {
  indexName: string
  nodeId: string
  engine: Pick<ClusterLocalEngine, 'heldPartitionsOf' | 'persistedPositionOf'>
  coordinator: Pick<ClusterCoordinator, 'getAllocation'>
  replicationLogs: Map<string, ReplicationLog>
  replicationConfig?: Partial<ReplicationConfig>
}

export function numberingFloor(persisted: PartitionLogPosition, assignment: PartitionAssignment): PartitionLogPosition {
  if (persisted.seqNo >= assignment.commitPoint) return persisted
  return { seqNo: assignment.commitPoint, primaryTerm: assignment.primaryTerm }
}

/**
 * Restores primary replication sequence floors after a local index reopens.
 *
 * @param input - The reopened index, allocation source, and local log registry.
 * @returns A promise that settles after every local primary log has its durable floor.
 */
export async function seedReopenedPrimaryLogs(input: ReopenReplicationInput): Promise<void> {
  const allocation = await input.coordinator.getAllocation(input.indexName)
  if (allocation === null) return
  for (const partitionId of input.engine.heldPartitionsOf(input.indexName) ?? []) {
    const assignment = allocation.assignments.get(partitionId)
    if (assignment?.primary !== input.nodeId) continue
    const floor = numberingFloor(input.engine.persistedPositionOf(input.indexName, partitionId), assignment)
    seedReplicationLog(
      input.replicationLogs,
      input.indexName,
      partitionId,
      floor.seqNo + 1,
      floor.primaryTerm,
      input.replicationConfig,
    )
  }
}

/**
 * Applies one replicated write while holding the index open for the full operation.
 *
 * @param core - The local engine services.
 * @param entry - The replicated write to apply.
 */
export async function applyLocalReplicationEntry(core: EngineCore, entry: ReplicationLogEntry): Promise<void> {
  core.guardShutdown()
  const release = await core.indexState.acquire(entry.indexName)
  try {
    const indexEntry = core.requireIndex(entry.indexName)
    const manager = core.requireManager(entry.indexName)
    const vecIndexes = manager.getVectorIndexes()
    const apply = (): void => {
      if (entry.operation === 'INDEX') applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes)
      else applyDeleteEntry(entry, manager, vecIndexes)
    }
    const durable = core.durability?.manager
    if (durable === undefined) {
      apply()
    } else {
      await durable.recordMutation({
        indexName: entry.indexName,
        partitionId: entry.partitionId,
        operation: entry.operation,
        documentId: entry.documentId,
        document: entry.document,
        apply,
        replicated: entry,
      })
    }

    if (entry.operation === 'INDEX') {
      const appliedDocument = manager.getRef(entry.documentId)
      if (appliedDocument !== undefined) {
        await core.orchestrator.replicateToWorkers({
          type: 'insert',
          indexName: entry.indexName,
          docId: entry.documentId,
          document: appliedDocument,
          requestId: `replicate-entry-insert-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
        })
      }
      return
    }

    await core.orchestrator.replicateToWorkers({
      type: 'remove',
      indexName: entry.indexName,
      docId: entry.documentId,
      requestId: `replicate-entry-remove-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
    })
  } finally {
    release()
  }
}
