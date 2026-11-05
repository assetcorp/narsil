import type { EngineCore } from '../core'
import type { IndexSyncState } from '../registry-entry'
import { oneSyncChangeAtATime } from './serial'

type AdoptingCore = Pick<EngineCore, 'durability' | 'indexRegistry'>

function sameState(held: IndexSyncState | null, next: IndexSyncState | null): boolean {
  if (held === null || next === null) return held === next
  return (
    held.epoch === next.epoch &&
    held.active === next.active &&
    held.historyMaxAgeMs === next.historyMaxAgeMs &&
    held.historyMaxBytes === next.historyMaxBytes
  )
}

export async function adoptIndexSyncState(
  core: AdoptingCore,
  indexName: string,
  next: IndexSyncState | null,
): Promise<boolean> {
  return oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
    const entry = core.indexRegistry.get(indexName)
    if (entry === undefined) return false
    const held = entry.sync
    if (sameState(held, next)) return false
    const storage = core.durability?.manager.syncStorage?.()
    const anotherEpoch = held !== null && next !== null && held.epoch !== next.epoch
    if (anotherEpoch) await storage?.release(indexName)
    entry.sync = next
    try {
      await core.durability?.manager.persistMetadata(indexName)
    } catch (error) {
      entry.sync = held
      throw error
    }
    if (next === null) await storage?.release(indexName)
    return true
  })
}
