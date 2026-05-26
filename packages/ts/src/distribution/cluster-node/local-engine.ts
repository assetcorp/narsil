import { createEngineCore, type EngineCore } from '../../engine/core'
import type { Narsil } from '../../narsil'
import { createNarsilFromCore } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationLogEntry } from '../replication/types'

export interface ClusterLocalEngine extends Narsil {
  applyReplicationEntry(entry: ReplicationLogEntry): Promise<void>
}

export async function createClusterLocalEngine(config?: NarsilConfig): Promise<ClusterLocalEngine> {
  const core = createEngineCore(config)
  const engine = createNarsilFromCore(core, config)

  return Object.assign(engine, {
    applyReplicationEntry: (entry: ReplicationLogEntry) => applyReplicationEntry(core, entry),
  })
}

async function applyReplicationEntry(core: EngineCore, entry: ReplicationLogEntry): Promise<void> {
  core.guardShutdown()
  const indexEntry = core.requireIndex(entry.indexName)
  const manager = core.requireManager(entry.indexName)
  const vecIndexes = manager.getVectorIndexes()

  if (entry.operation === 'INDEX') {
    applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes)
    core.flushManager?.markDirty(entry.indexName, entry.partitionId)
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
  core.flushManager?.markDirty(entry.indexName, entry.partitionId)
  await core.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName: entry.indexName,
    docId: entry.documentId,
    requestId: `replicate-entry-remove-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
  })
}
