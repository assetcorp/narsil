import { writeMetadataEnvelope } from '../../serialization/envelope'
import { countCheckpointDocuments } from './checkpoint-count'
import { recoverCheckpoint } from './checkpoint-recovery'
import type { DurableDirectory } from './durable-filesystem'
import { replayAcrossLayout, settleStoredLayout } from './layout-transition/recovery'
import { checkpointPrimaryTerm, type PartitionCheckpoint } from './partition-checkpoint'
import { loadMetadata, replayWal, snapshotCheckpointFor } from './recovery'
import { directoryCheckpointStore } from './segment/store'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import { settleStoredAnalysis } from './stored-analysis'
import type { SyncStorage } from './sync/storage'
import type { IndexDurabilityHooks } from './types'

export interface RecoverPersistedIndexDeps {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  compactionThreshold: number
  registerPartition(indexName: string, partitionId: number, startSeqNo: number, primaryTerm: number): void
  holdsCheckpointFiles(indexName: string): boolean
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
  syncStorage: SyncStorage
}

async function writeCountedMetadata(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  documentCount: number,
): Promise<void> {
  await deps.queueMetadataWrite(indexName, async () => {
    const metadata = deps.hooks.buildMetadata(indexName, documentCount)
    if (metadata === undefined) return
    const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
    await deps.directory.atomicWrite(`${indexName}/meta`, bytes)
  })
}

export async function recoverPersistedIndex(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  metadataOnly: boolean,
): Promise<(() => Promise<void>) | null> {
  const { directory, hooks } = deps
  const store = directoryCheckpointStore(directory)
  const metadata = await loadMetadata(directory, indexName)
  if (metadata === null) {
    return null
  }
  const layout = metadataOnly
    ? { transition: null, changedMetadata: false, replaysOldLayout: false }
    : await settleStoredLayout(store, metadata)
  let derivedCount: number | undefined
  if (metadataOnly && metadata.documentCount === undefined) {
    try {
      derivedCount = await countCheckpointDocuments(store, indexName)
      metadata.documentCount = derivedCount
    } catch {
      derivedCount = undefined
    }
  }
  const promoted = await settleStoredAnalysis(store, metadata, metadataOnly)
  await hooks.createIndexFromMetadata(metadata, !metadataOnly)

  if (metadataOnly) {
    if (derivedCount !== undefined || promoted || layout.changedMetadata) {
      await writeCountedMetadata(deps, indexName, derivedCount ?? metadata.documentCount ?? 0)
    }
    return null
  }

  const manager = hooks.getManager(indexName)
  const current = hooks.buildMetadata(indexName)
  if (manager === undefined || current === undefined) {
    return null
  }
  const writeRecords = hooks.writeRecords ?? null
  writeRecords?.dropIndex(indexName)
  const replayDeps = {
    manager,
    vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
    vectorIndexes: hooks.getVectorIndexes(indexName),
    writeRecords,
    defersGraphBuilds: true,
  }
  let removeUnread = async (): Promise<void> => undefined
  const replay = async (checkpoint: PartitionCheckpoint[]): Promise<PartitionCheckpoint[]> => {
    if (layout.replaysOldLayout && layout.transition !== null) {
      const replayed = await replayAcrossLayout(directory, indexName, layout.transition, checkpoint, replayDeps)
      removeUnread = replayed.removeUnread
      return replayed.checkpoint
    }
    const replayed: PartitionCheckpoint[] = []
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const fromSeqNo = snapshotCheckpointFor(checkpoint, partitionId)
      writeRecords?.loadTermHistory(
        indexName,
        partitionId,
        checkpoint.find(entry => entry.partitionId === partitionId),
      )
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

  const syncActive = metadata.sync?.enabled === true && metadata.syncActive === true
  const keptForSync = await deps.syncStorage.settleAtRecovery(indexName, syncActive)
  const recovered = await recoverCheckpoint({
    store,
    indexName,
    metadata: current,
    manager,
    vectorIndexes: replayDeps.vectorIndexes,
    storedTermsAreCurrent: metadata.analysisRevision === manager.language.revision,
    compactionThreshold: deps.compactionThreshold,
    keepsUnlistedFiles: deps.holdsCheckpointFiles(indexName),
    keptForSync,
    replay,
    onLayoutUpgrade: hooks.onLayoutUpgrade,
    writeRecords,
  })
  for (const { partitionId, lastSeqNo, primaryTerm } of recovered.checkpoint) {
    deps.registerPartition(indexName, partitionId, lastSeqNo, primaryTerm)
  }
  if (layout.transition === null && (recovered.upgradedDocumentCount !== null || promoted || layout.changedMetadata)) {
    await writeCountedMetadata(deps, indexName, recovered.upgradedDocumentCount ?? manager.countDocuments())
  }
  return layout.transition === null ? null : removeUnread
}

export async function recoverWithLayoutCheckpoint(
  deps: RecoverPersistedIndexDeps,
  indexName: string,
  metadataOnly: boolean,
  checkpoint: () => Promise<void>,
): Promise<void> {
  const removeUnread = await recoverPersistedIndex(deps, indexName, metadataOnly)
  if (removeUnread === null) return
  try {
    await checkpoint()
  } finally {
    await removeUnread()
  }
}
