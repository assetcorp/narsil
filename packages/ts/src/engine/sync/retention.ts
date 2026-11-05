import { unrefInterval } from '../../persistence/durability/directory-watch'
import { DEFAULT_HISTORY_MAX_AGE_MS } from '../../persistence/durability/sync/constants'
import type { EngineCore } from '../core'
import { emitEngineEvent } from '../events'
import { publishedArchiveLayout } from './archive'
import { HISTORY_SWEEP_INTERVAL_MS } from './constants'
import { publishedSyncSnapshot } from './snapshot'

interface RetentionState {
  running: Map<string, Promise<void>>
  again: Set<string>
  sweep: ReturnType<typeof setInterval> | null
}

const statesByCore = new WeakMap<EngineCore, RetentionState>()

function stateOf(core: EngineCore): RetentionState {
  let state = statesByCore.get(core)
  if (state === undefined) {
    state = { running: new Map(), again: new Set(), sweep: null }
    statesByCore.set(core, state)
  }
  return state
}

async function enforce(core: EngineCore, indexName: string): Promise<void> {
  const sync = core.indexRegistry.get(indexName)?.sync ?? null
  const storage = core.durability?.manager.syncStorage?.()
  if (sync === null || !sync.active || storage === undefined || core.shutdownState.isShutdown) return
  const published = await storage.published(indexName)
  const maxBytes =
    sync.historyMaxBytes ??
    (published === null ? Number.POSITIVE_INFINITY : publishedArchiveLayout(indexName, published, storage).byteLength)
  const publishesSnapshots = core.mutationCtx.capacityScope !== 'partition'
  await storage.enforceHistoryLimits(
    indexName,
    { maxAgeMs: sync.historyMaxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS, maxBytes },
    publishesSnapshots
      ? async () => {
          const { unpin } = await publishedSyncSnapshot(core, indexName, true)
          unpin()
        }
      : null,
    Date.now(),
  )
}

export function scheduleSyncRetention(core: EngineCore, indexName: string): void {
  const state = stateOf(core)
  startSyncRetentionSweep(core)
  if (state.running.has(indexName)) {
    state.again.add(indexName)
    return
  }
  const run = (async () => {
    do {
      state.again.delete(indexName)
      await enforce(core, indexName)
    } while (state.again.has(indexName))
  })()
    .catch((error: unknown) => {
      emitEngineEvent(core.eventHandlers, 'durabilityError', {
        error: error instanceof Error ? error : new Error(String(error)),
      })
    })
    .finally(() => state.running.delete(indexName))
  state.running.set(indexName, run)
}

export function startSyncRetentionSweep(core: EngineCore): void {
  const state = stateOf(core)
  if (state.sweep !== null) return
  state.sweep = unrefInterval(() => {
    if (core.shutdownState.isShutdown) {
      if (state.sweep !== null) clearInterval(state.sweep)
      return
    }
    for (const [indexName, entry] of core.indexRegistry) {
      if (entry.sync?.active === true) scheduleSyncRetention(core, indexName)
    }
  }, HISTORY_SWEEP_INTERVAL_MS)
}
