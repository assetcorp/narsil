import { resolvePartitionInsertOptions } from '#platform/storage-host'
import type { EngineCore } from '../engine/core'
import type { SyncChangeListener } from '../engine/sync-notify'
import type { SyncStorage } from '../persistence/durability/sync/storage'
import type { FeedChange } from '../sync/feed/source'
import { changesNotEnabled } from './cursor'
import { createDocumentTest, validChangeFilter } from './filter-test'
import type { ChangeSource } from './source'

const WRITE_EVENT = 'write'

type SourceCore = Pick<EngineCore, 'durability' | 'indexRegistry' | 'executor' | 'eventHandlers'>

function storageOf(core: SourceCore): SyncStorage | null {
  return core.durability?.manager.syncStorage?.() ?? null
}

function listenForWrites(core: SourceCore, onWrite: (payload: { indexName: string }) => void): () => void {
  let handlers = core.eventHandlers.get(WRITE_EVENT)
  if (handlers === undefined) {
    handlers = new Set()
    core.eventHandlers.set(WRITE_EVENT, handlers)
  }
  const registered = handlers
  const handler = (payload: unknown): void => onWrite(payload as { indexName: string })
  registered.add(handler)
  return () => {
    registered.delete(handler)
  }
}

export type ListenForSettingChanges = (registry: object, listener: SyncChangeListener) => () => void

export function engineChangeSource(core: SourceCore, listenForSettings?: ListenForSettingChanges): ChangeSource {
  const requireStorage = (indexName: string): SyncStorage => {
    const storage = storageOf(core)
    if (storage === null) throw changesNotEnabled(indexName)
    return storage
  }
  return {
    changesState(indexName) {
      const entry = core.indexRegistry.get(indexName)
      if (entry === undefined || entry.changes === null || storageOf(core) === null) return null
      return {
        epoch: entry.changes.epoch,
        partitionCount: entry.partitionCount,
        previousDocument: entry.changes.previousDocument,
      }
    },

    async documentTest(indexName, filter) {
      const entry = core.indexRegistry.get(indexName)
      const manager = core.executor.getManager(indexName)
      if (entry === undefined || manager === undefined) throw changesNotEnabled(indexName)
      const valid = validChangeFilter(filter, entry.config.schema)
      return createDocumentTest(
        {
          schema: entry.config.schema,
          language: entry.language,
          insertOptions: resolvePartitionInsertOptions(entry.config, manager.analysis),
          vectorFieldPaths: entry.vectorFieldPaths,
        },
        valid,
      )
    },

    async vectorFieldPaths(indexName) {
      const entry = core.indexRegistry.get(indexName)
      if (entry === undefined) throw changesNotEnabled(indexName)
      return entry.vectorFieldPaths
    },

    async bounds(indexName, partitionId) {
      const log = await requireStorage(indexName).openPartitionLog(indexName, partitionId)
      const applied = core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0
      return { oldestSeqNo: log.oldestSeqNo, head: log.head, highestSeqNo: Math.max(log.head, applied) }
    },

    async read(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes) {
      const storage = requireStorage(indexName)
      const read = await storage.readPartitionLog(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes)
      return { frames: read.frames, gone: read.gone }
    },

    async bytesBehind(indexName, seqNos) {
      const storage = requireStorage(indexName)
      let bytes = 0
      for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
        const log = await storage.openPartitionLog(indexName, partitionId)
        bytes += await storage.logBytesAfter(log, seqNos[partitionId])
      }
      return bytes
    },

    pendingBeyondHead(indexName, partitionId, head) {
      return (core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0) > head
    },

    listen(onChange: (change: FeedChange) => void) {
      const stopWrites = listenForWrites(core, payload => onChange({ kind: 'advanced', indexName: payload.indexName }))
      const stopSyncChanges = listenForSettings?.(core.indexRegistry, onChange)
      return () => {
        stopWrites()
        stopSyncChanges?.()
      }
    },
  }
}
