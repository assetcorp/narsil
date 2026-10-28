import type { EngineCore } from '../engine/core'
import { readDocumentExport } from '../engine/export/import'
import { documentExportStream } from '../engine/export/write'
import { announceIndexCreated, announceIndexDropped } from '../engine/index-lifecycle'
import {
  checkpointForArchive,
  createSnapshot,
  type RestoreDeps,
  restoreFromSnapshot,
  type SnapshotDeps,
} from '../engine/snapshot'
import { indexConfigurationOf } from '../engine/snapshot/index-configuration'
import { validateIndexName } from '../engine/validation'
import { getVectorFieldPaths } from '../engine/vector-fields'
import { emitWriteEventAfter } from '../engine/write-events'
import type { NarsilConfig } from '../types/config'
import type { ByteSource, Narsil } from '../types/engine'
import type { DocumentImportResult } from '../types/results'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../workers/constants'

export type PortabilityOperations = Pick<Narsil, 'snapshot' | 'restore' | 'exportDocuments' | 'importDocumentExport'>

export function portabilityOperations(
  core: EngineCore,
  config: NarsilConfig | undefined,
  engine: () => Narsil,
): PortabilityOperations {
  async function withOpenIndex<T>(indexName: string, action: () => Promise<T>): Promise<T> {
    core.guardShutdown()
    core.requireIndex(indexName)
    const release = await core.indexState.acquire(indexName)
    try {
      return await action()
    } finally {
      release()
    }
  }

  const restoresInFlight = new Map<string, Promise<void>>()
  const restoreDeps: RestoreDeps = {
    executor: core.executor,
    indexRegistry: core.indexRegistry,
    getVectorFieldPaths,
    announceIndexCreated: (name, restoredConfig) => announceIndexCreated(core, name, restoredConfig),
    announceIndexDropped: (name, replacedConfig) => announceIndexDropped(core, name, replacedConfig),
    durability: core.durability,
    filesystemDurability: core.filesystemDurability,
    embeddingAdapters: core.embeddingAdapters,
    defaultEmbeddingAdapter: config?.embedding ?? null,
    markAnalysisStale: core.analysisRebuild.markStale,
    clearAnalysisStale: core.analysisRebuild.clearStale,
    abandonAnalysisRebuild: core.analysisRebuild.abandon,
    indexState: core.indexState,
    copies: core.orchestrator,
    forgetWatermark: core.watermarkNotifier.forget,
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
    snapshot(indexName: string): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(indexName, () => createSnapshot(snapshotDepsOf(indexName)))
    },

    async restore(indexName: string, data: ByteSource): Promise<void> {
      core.guardShutdown()
      validateIndexName(indexName)
      const previous = restoresInFlight.get(indexName) ?? Promise.resolve()
      const restored = previous.then(() => restoreFromSnapshot(indexName, data, restoreDeps))
      const settled = restored.then(
        () => undefined,
        () => undefined,
      )
      restoresInFlight.set(indexName, settled)
      void settled.then(() => {
        if (restoresInFlight.get(indexName) === settled) restoresInFlight.delete(indexName)
      })
      await emitWriteEventAfter(core, indexName, restored)
      core.heapPressureNotifier.check(indexName)
    },

    exportDocuments(indexName: string): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(indexName, async () => {
        const header = indexConfigurationOf(core.requireIndex(indexName))
        return documentExportStream(header, await checkpointForArchive(snapshotDepsOf(indexName)))
      })
    },

    importDocumentExport(indexName: string, data: ByteSource): Promise<DocumentImportResult> {
      core.guardShutdown()
      return emitWriteEventAfter(core, indexName, readDocumentExport(engine(), indexName, data))
    },
  }
}
