import type { EngineCore } from '../../engine/core'
import type { ClusterCoordinator } from '../coordinator/types'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationConfig, ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { ClusterLocalEngine } from './local-engine'
import { seedReplicationLog } from './replication-logs'

interface ReopenReplicationInput {
  indexName: string
  nodeId: string
  engine: Pick<ClusterLocalEngine, 'heldPartitionsOf' | 'highestPersistedSeqNoOf'>
  coordinator: Pick<ClusterCoordinator, 'getAllocation'>
  replicationLogs: Map<string, ReplicationLog>
  replicationConfig?: Partial<ReplicationConfig>
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
    const floor = Math.max(input.engine.highestPersistedSeqNoOf(input.indexName, partitionId), assignment.commitPoint)
    seedReplicationLog(
      input.replicationLogs,
      input.indexName,
      partitionId,
      floor + 1,
      assignment.primaryTerm,
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

    if (entry.operation === 'INDEX') {
      applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes)
      const appliedDocument = manager.get(entry.documentId)
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

    applyDeleteEntry(entry, manager, vecIndexes)
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
