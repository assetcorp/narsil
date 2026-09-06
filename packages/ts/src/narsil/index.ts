import { createEngineCore } from '../engine/core'
import { checkHeapAfterRecovery } from '../engine/notifiers'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import { createNarsilFromCore } from './operations'

export type { Narsil } from '../types/engine'
export { createNarsilFromCore } from './operations'

/**
 * Creates a search engine that runs inside your process, with no server to
 * provision.
 *
 * The engine holds every index you create, so an application usually keeps one
 * instance for its lifetime. When you configure persistence, this recovers the
 * indexes already on disk before it resolves. Lifecycle settings register
 * those indexes as closed and load each one when its first request arrives.
 *
 * @param config - This carries the persistence, partitioning, and worker
 * invalidation settings. Omit it for an engine that keeps everything in memory.
 * @returns The engine, ready for {@link Narsil.createIndex} to run against.
 *
 * @public
 */
export async function createNarsil(config?: NarsilConfig): Promise<Narsil> {
  const core = createEngineCore(config)
  if (core.durability) {
    await core.durability.manager.recover(config?.lifecycle !== undefined)
    checkHeapAfterRecovery(core)
  }
  if (core.invalidation) {
    await core.invalidation.start()
  }
  if (config?.lifecycle === undefined) await core.analysisRebuild.reviewStaleIndexes()
  return createNarsilFromCore(core, config)
}
