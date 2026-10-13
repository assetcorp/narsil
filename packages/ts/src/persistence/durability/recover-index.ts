import { writeMetadataEnvelope } from '../../serialization/envelope'
import { countCheckpointDocuments } from './checkpoint-count'
import { recoverCheckpoint } from './checkpoint-recovery'
import type { DurableDirectory } from './durable-filesystem'
import { checkpointPrimaryTerm, type PartitionCheckpoint } from './partition-checkpoint'
import { loadMetadata, replayWal, snapshotCheckpointFor } from './recovery'
import { directoryCheckpointStore } from './segment/store'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { IndexDurabilityHooks } from './types'

export interface RecoverPersistedIndexDeps {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  compactionThreshold: number
  registerPartition(indexName: string, partitionId: number, startSeqNo: number): void
  holdsCheckpointFiles(indexName: string): boolean
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
}

async function writeCountedMetadata(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  documentCount: number,
): Promise<void> {
  await deps
    .queueMetadataWrite(indexName, async () => {
      const metadata = deps.hooks.buildMetadata(indexName, documentCount)
      if (metadata === undefined) return
      const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
      await deps.directory.atomicWrite(`${indexName}/meta`, bytes)
    })
    .catch(() => undefined)
}

export async function recoverPersistedIndex(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  metadataOnly: boolean,
): Promise<void> {
  const { directory, hooks } = deps
  const store = directoryCheckpointStore(directory)
  const metadata = await loadMetadata(directory, indexName)
  if (metadata === null) {
    return
  }
  let derivedCount: number | undefined
  if (metadataOnly && metadata.documentCount === undefined) {
    try {
      derivedCount = await countCheckpointDocuments(store, indexName)
      metadata.documentCount = derivedCount
    } catch {
      derivedCount = undefined
    }
  }
  await hooks.createIndexFromMetadata(metadata, !metadataOnly)

  if (metadataOnly) {
    if (derivedCount !== undefined) await writeCountedMetadata(deps, indexName, derivedCount)
    return
  }

  const manager = hooks.getManager(indexName)
  const current = hooks.buildMetadata(indexName)
  if (manager === undefined || current === undefined) {
    return
  }
  const replayDeps = {
    manager,
    vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
    vectorIndexes: hooks.getVectorIndexes(indexName),
  }
  const replay = async (checkpoint: PartitionCheckpoint[]): Promise<PartitionCheckpoint[]> => {
    const replayed: PartitionCheckpoint[] = []
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const fromSeqNo = snapshotCheckpointFor(checkpoint, partitionId)
      const { highestSeqNo, highestPrimaryTerm } = await replayWal(
        directory,
        indexName,
        partitionId,
        fromSeqNo,
        replayDeps,
      )
      const primaryTerm = Math.max(
        checkpointPrimaryTerm(checkpoint, partitionId),
        highestPrimaryTerm,
        SINGLE_NODE_PRIMARY_TERM,
      )
      replayed.push({ partitionId, lastSeqNo: highestSeqNo, primaryTerm })
    }
    return replayed
  }

  const recovered = await recoverCheckpoint({
    store,
    indexName,
    metadata: current,
    manager,
    vectorIndexes: replayDeps.vectorIndexes,
    storedTermsAreCurrent: metadata.analysisRevision === manager.language.revision,
    compactionThreshold: deps.compactionThreshold,
    keepsUnlistedFiles: deps.holdsCheckpointFiles(indexName),
    replay,
    onLayoutUpgrade: hooks.onLayoutUpgrade,
  })
  for (const { partitionId, lastSeqNo } of recovered.checkpoint) {
    deps.registerPartition(indexName, partitionId, lastSeqNo)
  }
  if (recovered.upgradedDocumentCount !== null) {
    await writeCountedMetadata(deps, indexName, recovered.upgradedDocumentCount)
  }
}
