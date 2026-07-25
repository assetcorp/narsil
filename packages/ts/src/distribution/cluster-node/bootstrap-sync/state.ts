import { ABORT_SENTINEL } from '../bootstrap-restore'
import type { BootstrapEntry, BootstrapSyncDeps, BootstrapSyncState, LiveBootstrapSyncDeps } from './types'

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000

export function createBootstrapSyncState(): BootstrapSyncState {
  return {
    inFlight: new Map(),
    completed: new Set(),
    generations: new Map(),
  }
}

export function entryKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function hasLiveBootstrapSyncDeps(deps: BootstrapSyncDeps): deps is LiveBootstrapSyncDeps {
  return (
    deps.getReplicationLog !== undefined &&
    deps.resetReplicationLog !== undefined &&
    deps.applyReplicationEntry !== undefined &&
    deps.restoreReplicationPartition !== undefined
  )
}

export function clearBootstrapSyncIndex(state: BootstrapSyncState, indexName: string, partitionId: number): void {
  const key = entryKey(indexName, partitionId)
  state.completed.delete(key)
  const inFlight = state.inFlight.get(key)
  if (inFlight === undefined) {
    // Generations are only meaningful while an in-flight worker watches
    // its own generation to detect eviction. With no worker to invalidate,
    // the slot is free; clear any lingering counter so a future bootstrap
    // starts clean.
    state.generations.delete(key)
    return
  }
  // Bump the generation and eagerly evict the in-flight entry. Eviction
  // allows a fresh runBootstrapSync for the same key to start immediately
  // rather than absorbing the aborted entry and returning false. The
  // draining worker observes the generation mismatch at its next check
  // (see executeBootstrapSync / applyRestore) and its .finally is a no-op
  // because state.inFlight no longer maps the key to it.
  const previous = state.generations.get(key) ?? 0
  state.generations.set(key, previous + 1)
  inFlight.aborted = true
  inFlight.abortResolve()
  state.inFlight.delete(key)
}

export function hasCompletedBootstrapSync(state: BootstrapSyncState, indexName: string, partitionId: number): boolean {
  return state.completed.has(entryKey(indexName, partitionId))
}

export function createEntry(
  state: BootstrapSyncState,
  indexName: string,
  partitionId: number,
  key: string,
): BootstrapEntry {
  const startGeneration = state.generations.get(key) ?? 0
  let abortResolve: () => void = () => {}
  const abortPromise = new Promise<typeof ABORT_SENTINEL>(resolve => {
    abortResolve = () => resolve(ABORT_SENTINEL)
  })
  return {
    indexName,
    partitionId,
    generation: startGeneration,
    promise: Promise.resolve(false),
    aborted: false,
    abortResolve,
    abortPromise,
  }
}

export function anotherBootstrapOwnsKey(state: BootstrapSyncState, key: string, self: BootstrapEntry): boolean {
  const current = state.inFlight.get(key)
  if (current === undefined) {
    return false
  }
  return current !== self
}
