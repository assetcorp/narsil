import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { IndexMetadata } from '../../types/internal'
import { readSegmentManifest } from './segment/load'
import type { CheckpointStore } from './segment/store'

function promotePendingAnalysis(metadata: IndexMetadata): void {
  const pending = metadata.pendingAnalysis
  if (pending === undefined) return
  metadata.language = pending.language
  metadata.analysisGeneration = pending.generation
  metadata.analysisRevision = undefined
  metadata.tokenizer = pending.tokenizer
  metadata.stopWords = pending.stopWords
  metadata.stopWordList = pending.stopWordList
  metadata.pendingAnalysis = undefined
}

export async function settleStoredAnalysis(
  store: CheckpointStore,
  metadata: IndexMetadata,
  metadataOnly: boolean,
): Promise<boolean> {
  if (metadataOnly && metadata.pendingAnalysis === undefined) return false
  const decoded = await readSegmentManifest(store, metadata.indexName)
  const partitionCount = decoded?.kind === 'current' ? decoded.manifest.checkpoint.length : metadata.partitionCount
  const changedLayout = partitionCount !== metadata.partitionCount
  metadata.partitionCount = partitionCount
  const stored = decoded === null ? null : decoded.kind === 'current' ? (decoded.manifest.analysisGeneration ?? 0) : 0
  const current = metadata.analysisGeneration ?? 0
  if (stored === null || stored === current) return changedLayout
  if (stored === metadata.pendingAnalysis?.generation) {
    promotePendingAnalysis(metadata)
    return true
  }
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The saved terms of index "${metadata.indexName}" come from analysis generation ${stored}, which matches no settings that its metadata records`,
    {
      indexName: metadata.indexName,
      storedGeneration: stored,
      currentGeneration: current,
      pendingGeneration: metadata.pendingAnalysis?.generation,
    },
  )
}
