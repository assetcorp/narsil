import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { EngineCore } from './core'
import { checkHeapAfterRecovery } from './notifiers'

export async function startEngineCore(core: EngineCore, config: NarsilConfig | undefined): Promise<void> {
  try {
    if (core.durability) {
      await core.durability.manager.recover(config?.lifecycle !== undefined)
      checkHeapAfterRecovery(core)
    }
    if (core.invalidation) await core.invalidation.start()
    if (config?.lifecycle === undefined) await core.analysisRebuild.reviewStaleIndexes()
  } catch (err) {
    await core.durability?.manager.shutdown().catch(() => undefined)
    await shutdownEngine(core).catch(() => undefined)
    throw err
  }
}

export async function shutdownEngine(core: EngineCore): Promise<void> {
  const { executor, durability, indexRegistry, eventHandlers, orchestrator } = core

  core.indexState.dispose()

  if (durability) {
    await durability.manager.shutdown()
  }

  for (const [name] of indexRegistry) {
    const manager = executor.getManager(name)
    if (manager) {
      for (const [, vectorIndex] of manager.getVectorIndexes()) {
        vectorIndex.dispose()
      }
    }
  }

  if (core.invalidation) {
    await core.invalidation.shutdown()
  }

  const adaptersToShutdown = new Set<EmbeddingAdapter>()
  for (const [, entry] of indexRegistry) {
    if (entry.embeddingAdapter?.shutdown) {
      adaptersToShutdown.add(entry.embeddingAdapter)
    }
  }
  for (const adapter of adaptersToShutdown) {
    try {
      await adapter.shutdown?.()
    } catch {}
  }

  if (core.rerankAdapters.size > 0) {
    await (await import('../rerank/runtime')).shutdownRerankAdapters(core.rerankAdapters)
  }

  await orchestrator.shutdown()
  await executor.shutdown()
  eventHandlers.clear()
  indexRegistry.clear()
}
