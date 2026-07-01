import type { EmbeddingAdapter } from '../types/adapters'
import type { EngineCore } from './core'

export async function shutdownEngine(core: EngineCore): Promise<void> {
  const { executor, durability, indexRegistry, eventHandlers, orchestrator } = core

  for (const [name] of indexRegistry) {
    const manager = executor.getManager(name)
    if (manager) {
      for (const [, vectorIndex] of manager.getVectorIndexes()) {
        vectorIndex.dispose()
      }
    }
  }

  if (durability) {
    await durability.manager.shutdown()
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
    } catch {
      // Shutdown is best effort: one adapter's cleanup failure must not block the rest of teardown.
    }
  }

  await orchestrator.shutdown()
  await executor.shutdown()
  eventHandlers.clear()
  indexRegistry.clear()
}
