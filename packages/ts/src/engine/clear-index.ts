import type { EngineCore } from './core'
import { withRenewedSyncEpoch } from './sync-epoch'

export function clearEngineIndex(core: EngineCore, indexName: string): Promise<void> {
  return withRenewedSyncEpoch(core, indexName, async () => {
    await core.executor.execute({ type: 'clear', indexName, requestId: indexName })
    core.watermarkNotifier.forget(indexName)
    const durable = core.durability?.manager
    await (durable?.checkpointFromMemory?.(indexName) ?? durable?.checkpoint(indexName))
  })
}
