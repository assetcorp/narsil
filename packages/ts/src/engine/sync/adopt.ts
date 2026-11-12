import type { EngineCore } from '../core'
import type { IndexChangesState, IndexSyncState } from '../registry-entry'
import type { EpochStates } from './operations'
import { oneSyncChangeAtATime } from './serial'

type AdoptingCore = Pick<EngineCore, 'durability' | 'indexRegistry'>

function sameSync(held: IndexSyncState | null, next: IndexSyncState | null): boolean {
  if (held === null || next === null) return held === next
  return (
    held.epoch === next.epoch &&
    held.active === next.active &&
    held.historyMaxAgeMs === next.historyMaxAgeMs &&
    held.historyMaxBytes === next.historyMaxBytes
  )
}

function sameChanges(held: IndexChangesState | null, next: IndexChangesState | null): boolean {
  if (held === null || next === null) return held === next
  return (
    held.epoch === next.epoch &&
    held.previousDocument === next.previousDocument &&
    held.historyMaxAgeMs === next.historyMaxAgeMs &&
    held.historyMaxBytes === next.historyMaxBytes
  )
}

function epochOf(states: EpochStates): string | null {
  return states.sync?.epoch ?? states.changes?.epoch ?? null
}

export async function adoptIndexEpochStates(
  core: AdoptingCore,
  indexName: string,
  next: EpochStates,
): Promise<boolean> {
  return oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
    const entry = core.indexRegistry.get(indexName)
    if (entry === undefined) return false
    const held: EpochStates = { sync: entry.sync, changes: entry.changes }
    if (sameSync(held.sync, next.sync) && sameChanges(held.changes, next.changes)) return false
    const storage = core.durability?.manager.syncStorage?.()
    const heldEpoch = epochOf(held)
    const nextEpoch = epochOf(next)
    if (heldEpoch !== null && nextEpoch !== null && heldEpoch !== nextEpoch) await storage?.release(indexName)
    entry.sync = next.sync
    entry.changes = next.changes
    try {
      await core.durability?.manager.persistMetadata(indexName)
    } catch (error) {
      entry.sync = held.sync
      entry.changes = held.changes
      throw error
    }
    if (next.sync === null && held.sync !== null) await storage?.release(indexName, next.changes !== null)
    else if (nextEpoch === null && heldEpoch !== null) await storage?.release(indexName)
    return true
  })
}
