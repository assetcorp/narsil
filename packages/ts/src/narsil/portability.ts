import type { EngineCore } from '../engine/core'
import { announceIndexCreated, announceIndexDropped } from '../engine/index-lifecycle'
import { withOpenIndex } from '../engine/serial-index-update'
import type { SnapshotDeps } from '../engine/snapshot'
import { validateIndexName } from '../engine/validation'
import { getVectorFieldPaths } from '../engine/vector-fields'
import { emitWriteEventAfter } from '../engine/write-events'
import { loadStorageCode } from '../persistence/storage-code'
import type { ByteSource } from '../types/byte-source'
import type { NarsilConfig } from '../types/config'
import type { Narsil, SnapshotOptions } from '../types/engine'
import type { DocumentImportResult } from '../types/results'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../workers/constants'
import type { RestoreHost } from './restore-queue'
import { loadRestoreQueue } from './restore-queue-code'

export type PortabilityOperations = Pick<Narsil, 'snapshot' | 'restore' | 'exportDocuments' | 'importDocumentExport'>

export function portabilityOperations(
  core: EngineCore,
  config: NarsilConfig | undefined,
  engine: () => Narsil,
): PortabilityOperations {
  function queueRestore(indexName: string, data: ByteSource): Promise<void> {
    const { restoresInFlight } = core
    const previous = restoresInFlight.get(indexName) ?? Promise.resolve()
    const restored = previous.then(async () => {
      const { runRestore } = await loadRestoreQueue()
      await runRestore(core, restoreHost, indexName, data, engine())
    })
    const settled = restored.then(
      () => undefined,
      () => undefined,
    )
    restoresInFlight.set(indexName, settled)
    void settled.then(() => {
      if (restoresInFlight.get(indexName) === settled) restoresInFlight.delete(indexName)
    })
    return restored
  }

  const restoreHost: RestoreHost = {
    getVectorFieldPaths,
    announceIndexCreated: (name, restoredConfig) => announceIndexCreated(core, name, restoredConfig),
    announceIndexDropped: (name, replacedConfig) => announceIndexDropped(core, name, replacedConfig),
    defaultEmbeddingAdapter: config?.embedding ?? null,
    releaseTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  }

  function snapshotDepsOf(indexName: string): SnapshotDeps {
    return {
      indexName,
      manager: core.requireManager(indexName),
      entry: core.requireIndex(indexName),
      durability: core.durability,
    }
  }

  return {
    snapshot(indexName: string, options?: SnapshotOptions): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(core, indexName, async () => {
        const { createSnapshot } = await loadStorageCode()
        return createSnapshot(snapshotDepsOf(indexName), options?.queryHistory === true ? core : null)
      })
    },

    async restore(indexName: string, data: ByteSource): Promise<void> {
      core.guardShutdown()
      validateIndexName(indexName)
      await emitWriteEventAfter(core, indexName, queueRestore(indexName, data))
      core.heapPressureNotifier.check(indexName)
    },

    exportDocuments(indexName: string): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(core, indexName, async () => {
        const { openDocumentExport } = await loadStorageCode()
        return openDocumentExport(core, snapshotDepsOf(indexName))
      })
    },

    importDocumentExport(indexName: string, data: ByteSource): Promise<DocumentImportResult> {
      core.guardShutdown()
      const imported = loadStorageCode().then(({ readDocumentExport }) => readDocumentExport(engine(), indexName, data))
      return emitWriteEventAfter(core, indexName, imported)
    },
  }
}
