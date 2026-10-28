import type { EngineCore } from '../engine/core'
import { readDocumentExport } from '../engine/export/import'
import { announceIndexCreated, announceIndexDropped } from '../engine/index-lifecycle'
import type { SnapshotDeps } from '../engine/snapshot'
import { indexConfigurationOf } from '../engine/snapshot/index-configuration'
import { validateIndexName } from '../engine/validation'
import { getVectorFieldPaths } from '../engine/vector-fields'
import { emitWriteEventAfter } from '../engine/write-events'
import type { ByteSource } from '../types/byte-source'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import type { DocumentImportResult } from '../types/results'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../workers/constants'
import type { RestoreHost } from './restore-queue'

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
    snapshot(indexName: string): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(indexName, async () => {
        const { createSnapshot } = await import('../engine/snapshot')
        return createSnapshot(snapshotDepsOf(indexName))
      })
    },

    async restore(indexName: string, data: ByteSource): Promise<void> {
      core.guardShutdown()
      validateIndexName(indexName)
      const restored = import('./restore-queue').then(({ queueRestore }) =>
        queueRestore(core, restoreHost, restoresInFlight, indexName, data),
      )
      await emitWriteEventAfter(core, indexName, restored)
      core.heapPressureNotifier.check(indexName)
    },

    exportDocuments(indexName: string): Promise<ReadableStream<Uint8Array>> {
      return withOpenIndex(indexName, async () => {
        const [{ checkpointForArchive }, { documentExportStream }] = await Promise.all([
          import('../engine/snapshot'),
          import('../engine/export/write'),
        ])
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
