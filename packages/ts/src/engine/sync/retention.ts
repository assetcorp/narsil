import { emitEngineEvent } from '#platform/storage-host'
import { unrefInterval } from '../../persistence/durability/directory-watch'
import { manifestFileRefs } from '../../persistence/durability/segment/manifest'
import {
  DEFAULT_CHANGES_HISTORY_MAX_BYTES_FLOOR,
  DEFAULT_HISTORY_MAX_AGE_MS,
} from '../../persistence/durability/sync/constants'
import type { HistoryLimits, SyncStorage } from '../../persistence/durability/sync/storage'
import type { EngineCore } from '../core'
import type { IndexChangesState, IndexSyncState } from '../registry-entry'
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

async function syncLimits(sync: IndexSyncState, storage: SyncStorage, indexName: string): Promise<HistoryLimits> {
  const published = sync.historyMaxBytes === undefined ? await storage.published(indexName) : null
  return {
    maxAgeMs: sync.historyMaxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS,
    maxBytes:
      sync.historyMaxBytes ??
      (published === null
        ? Number.POSITIVE_INFINITY
        : publishedArchiveLayout(indexName, published, storage).byteLength),
  }
}

async function changesLimits(changes: IndexChangesState, storage: SyncStorage, indexName: string) {
  let maxBytes = changes.historyMaxBytes
  if (maxBytes === undefined) {
    const manifest = await storage.currentManifest(indexName)
    let checkpointBytes = 0
    if (manifest !== null) for (const ref of manifestFileRefs(manifest)) checkpointBytes += ref.bytes
    maxBytes = Math.max(checkpointBytes, DEFAULT_CHANGES_HISTORY_MAX_BYTES_FLOOR)
  }
  return { maxAgeMs: changes.historyMaxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS, maxBytes }
}

async function historyLimitsOf(
  sync: IndexSyncState | null,
  changes: IndexChangesState | null,
  storage: SyncStorage,
  indexName: string,
): Promise<HistoryLimits | null> {
  const kept = sync?.active === true ? await syncLimits(sync, storage, indexName) : null
  const captured = changes === null ? null : await changesLimits(changes, storage, indexName)
  if (kept === null) return captured
  if (captured === null) return kept
  return { maxAgeMs: Math.max(kept.maxAgeMs, captured.maxAgeMs), maxBytes: Math.max(kept.maxBytes, captured.maxBytes) }
}

async function enforce(core: EngineCore, indexName: string): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  const storage = core.durability?.manager.syncStorage?.()
  if (entry === undefined || storage === undefined || core.shutdownState.isShutdown) return
  const limits = await historyLimitsOf(entry.sync, entry.changes, storage, indexName)
  if (limits === null) return
  const publishesSnapshots = entry.sync?.active === true && core.mutationCtx.capacityScope !== 'partition'
  await storage.enforceHistoryLimits(
    indexName,
    limits,
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
      if (entry.sync?.active === true || entry.changes !== null) scheduleSyncRetention(core, indexName)
    }
  }, HISTORY_SWEEP_INTERVAL_MS)
}
