import { writeMetadataEnvelope } from '../../serialization/envelope'
import { countCheckpointDocuments } from './checkpoint-count'
import type { DurableDirectory } from './durable-filesystem'
import { loadMetadata, loadSnapshot, replayWal, snapshotCheckpointFor } from './recovery'
import { readSegmentManifest, reclaimOrphanedSegments } from './segment'
import type { IndexDurabilityHooks } from './types'

export interface RecoverPersistedIndexDeps {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  registerPartition(indexName: string, partitionId: number, startSeqNo: number): void
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
}

/**
 * Recovers one persisted index from the write-ahead tier. A metadata-only
 * recovery registers the index closed, and when its metadata predates the
 * checkpoint count it derives the count from the checkpoint and writes the
 * upgraded metadata back. A count the store fails to back stays absent, so
 * the metadata never carries a number no checkpoint produced. A full recovery
 * loads the checkpoint, replays the log, and registers each partition at its
 * highest replayed sequence number.
 *
 * @param deps - The durable store, the engine hooks, and the manager's
 * partition and metadata registrars.
 * @param indexName - The index to recover.
 * @param metadataOnly - True registers the index closed without loading data.
 */
export async function recoverPersistedIndex(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  metadataOnly: boolean,
): Promise<void> {
  const { directory, hooks } = deps
  const metadata = await loadMetadata(directory, indexName)
  if (metadata === null) {
    return
  }
  let derivedCount: number | undefined
  if (metadataOnly && metadata.documentCount === undefined) {
    try {
      derivedCount = await countCheckpointDocuments(directory, indexName)
      metadata.documentCount = derivedCount
    } catch {
      derivedCount = undefined
    }
  }
  await hooks.createIndexFromMetadata(metadata, !metadataOnly)

  if (metadataOnly) {
    if (derivedCount !== undefined) {
      await deps
        .queueMetadataWrite(indexName, async () => {
          const upgraded = hooks.buildMetadata(indexName, derivedCount)
          if (upgraded === undefined) {
            return
          }
          const bytes = await writeMetadataEnvelope(upgraded, { checksum: true })
          await directory.atomicWrite(`${indexName}/meta`, bytes)
        })
        .catch(() => undefined)
    }
    return
  }

  const manager = hooks.getManager(indexName)
  if (manager === undefined) {
    return
  }
  const replayDeps = {
    manager,
    vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
    vectorIndexes: hooks.getVectorIndexes(indexName),
  }

  const checkpoint = await loadSnapshot(directory, indexName, replayDeps)

  const manifest = await readSegmentManifest(directory, indexName)
  if (manifest !== null) {
    await reclaimOrphanedSegments(directory, indexName, manifest)
  }

  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
    const fromSeqNo = snapshotCheckpointFor(checkpoint, partitionId)
    const { highestSeqNo } = await replayWal(directory, indexName, partitionId, fromSeqNo, replayDeps)
    deps.registerPartition(indexName, partitionId, highestSeqNo)
  }
}
