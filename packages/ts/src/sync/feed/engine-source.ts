import { compareCodePoints } from '../../core/ordering'
import type { EngineCore } from '../../engine/core'
import type { IndexRegistryEntry } from '../../engine/registry-entry'
import { publishedArchiveLayout } from '../../engine/sync/archive'
import { listenForSyncChanges } from '../../engine/sync-notify'
import { rulesOfStoredSynonyms } from '../../engine/synonym-sets'
import { ErrorCodes, NarsilError } from '../../errors'
import { estimatedArchiveBytes } from '../../persistence/archive/range-layout'
import { manifestFileRefs } from '../../persistence/durability/segment/manifest'
import type { SyncStorage } from '../../persistence/durability/sync/storage'
import type { Narsil } from '../../types/engine'
import type { SyncSettings } from '../protocol'
import type { FeedChange, FeedIndexState, FeedSource } from './source'

export function syncSettingsOf(entry: IndexRegistryEntry): SyncSettings {
  const { config } = entry
  const synonyms = entry.synonyms === null ? [] : rulesOfStoredSynonyms(entry.synonyms)
  return {
    language: entry.language.name,
    ...(typeof config.tokenizer === 'string' ? { tokenizer: config.tokenizer } : {}),
    ...(typeof config.stopWords === 'string' ? { stopWords: config.stopWords } : {}),
    ...(config.stopWords instanceof Set ? { stopWordList: [...config.stopWords].sort(compareCodePoints) } : {}),
    ...(entry.analysisRevision !== null ? { analysisRevision: entry.analysisRevision } : {}),
    ...(config.bm25 !== undefined ? { bm25: config.bm25 } : {}),
    ...(synonyms.length > 0 ? { synonyms } : {}),
  }
}

function storageOf(core: EngineCore): SyncStorage | null {
  return core.durability?.manager.syncStorage?.() ?? null
}

export function engineFeedSource(engine: Narsil, core: EngineCore): FeedSource {
  const requireStorage = (): SyncStorage => {
    const storage = storageOf(core)
    if (storage === null) {
      throw new NarsilError(ErrorCodes.SYNC_DURABILITY_REQUIRED, 'Device sync needs write-ahead log durability')
    }
    return storage
  }
  return {
    indexState(indexName): FeedIndexState | null {
      const entry = core.indexRegistry.get(indexName)
      if (entry === undefined || entry.sync === null || storageOf(core) === null) return null
      return { epoch: entry.sync.epoch, partitionCount: entry.partitionCount, settings: syncSettingsOf(entry) }
    },

    async bounds(indexName, partitionId) {
      const log = await requireStorage().openPartitionLog(indexName, partitionId)
      const applied = core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0
      return { oldestSeqNo: log.oldestSeqNo, head: log.head, highestSeqNo: Math.max(log.head, applied) }
    },

    async read(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes) {
      const read = await requireStorage().readPartitionLog(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes)
      return { frames: read.frames, gone: read.gone }
    },

    async bytesBehind(indexName, seqNos) {
      const storage = requireStorage()
      let bytes = 0
      for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
        const log = await storage.openPartitionLog(indexName, partitionId)
        bytes += await storage.logBytesAfter(log, seqNos[partitionId])
      }
      return bytes
    },

    async snapshotBytes(indexName) {
      const storage = requireStorage()
      const published = await storage.published(indexName)
      if (published !== null) return publishedArchiveLayout(indexName, published, storage).byteLength
      const manifest = await storage.currentManifest(indexName)
      if (manifest === null) return 0
      return estimatedArchiveBytes(manifestFileRefs(manifest))
    },

    pendingBeyondHead(indexName, partitionId, head) {
      return (core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0) > head
    },

    listen(onChange: (change: FeedChange) => void) {
      const onWrite = (payload: { indexName: string }): void =>
        onChange({ kind: 'advanced', indexName: payload.indexName })
      engine.on('write', onWrite)
      const stopSyncChanges = listenForSyncChanges(core.indexRegistry, onChange)
      return () => {
        engine.off('write', onWrite)
        stopSyncChanges()
      }
    },
  }
}
