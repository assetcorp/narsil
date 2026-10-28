import type { EngineCore } from '../engine/core'
import type { RestoreDeps } from '../engine/snapshot'
import type { ByteSource } from '../types/byte-source'

export type RestoreHost = Pick<
  RestoreDeps,
  | 'getVectorFieldPaths'
  | 'announceIndexCreated'
  | 'announceIndexDropped'
  | 'defaultEmbeddingAdapter'
  | 'releaseTimeoutMs'
>

function restoreDepsOf(core: EngineCore, host: RestoreHost): RestoreDeps {
  return {
    ...host,
    executor: core.executor,
    indexRegistry: core.indexRegistry,
    durability: core.durability,
    filesystemDurability: core.filesystemDurability,
    embeddingAdapters: core.embeddingAdapters,
    markAnalysisStale: core.analysisRebuild.markStale,
    clearAnalysisStale: core.analysisRebuild.clearStale,
    abandonAnalysisRebuild: core.analysisRebuild.abandon,
    indexState: core.indexState,
    copies: core.orchestrator,
    forgetWatermark: core.watermarkNotifier.forget,
  }
}

export function queueRestore(
  core: EngineCore,
  host: RestoreHost,
  restoresInFlight: Map<string, Promise<void>>,
  indexName: string,
  data: ByteSource,
): Promise<void> {
  const previous = restoresInFlight.get(indexName) ?? Promise.resolve()
  const restored = previous.then(async () => {
    const { restoreFromSnapshot } = await import('../engine/snapshot')
    await restoreFromSnapshot(indexName, data, restoreDepsOf(core, host))
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
