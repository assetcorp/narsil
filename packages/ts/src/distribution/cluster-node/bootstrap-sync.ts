import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'
import type { ClusterCoordinator } from '../coordinator/types'
import type { NodeTransport } from '../transport/types'
import { fetchSnapshotFromAnyTarget } from './bootstrap-fetch'
import {
  ABORT_SENTINEL,
  dropExistingIndex,
  dropRestoredIndexQuietly,
  executeEngineRestore,
  loadCoordinatorSchema,
  resolveTransportTargets,
  surfaceAborted,
  surfaceError,
  validateArguments,
  validateRestoredSchema,
} from './bootstrap-restore'

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000

interface BootstrapEntry {
  indexName: string
  partitionId: number
  generation: number
  promise: Promise<boolean>
  aborted: boolean
  abortResolve: () => void
  abortPromise: Promise<typeof ABORT_SENTINEL>
}

export interface BootstrapSyncState {
  inFlight: Map<string, BootstrapEntry>
  completed: Set<string>
  generations: Map<string, number>
}

export function createBootstrapSyncState(): BootstrapSyncState {
  return {
    inFlight: new Map(),
    completed: new Set(),
    generations: new Map(),
  }
}

function entryKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
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

export interface BootstrapSyncDeps {
  engine: Narsil
  coordinator: ClusterCoordinator
  transport: NodeTransport
  sourceNodeId: string
  resolveNodeTargets: (nodeId: string) => Promise<string[]>
  onError?: (error: unknown) => void
  deadlineMs?: number
}

export async function runBootstrapSync(
  state: BootstrapSyncState,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const validationError = validateArguments(indexName, partitionId, primaryNodeId)
  if (validationError !== null) {
    surfaceError(deps, indexName, primaryNodeId, validationError)
    return false
  }

  const key = entryKey(indexName, partitionId)

  if (state.completed.has(key)) {
    return true
  }

  const existing = state.inFlight.get(key)
  if (existing !== undefined) {
    const result = await Promise.race([existing.promise, existing.abortPromise])
    if (result === ABORT_SENTINEL) {
      return false
    }
    return result
  }

  const entry = createEntry(state, indexName, partitionId, key)
  entry.promise = executeBootstrapSync(state, entry, indexName, partitionId, primaryNodeId, deps).finally(() => {
    const current = state.inFlight.get(key)
    if (current === entry) {
      state.inFlight.delete(key)
    }
    if (!state.completed.has(key) && !state.inFlight.has(key)) {
      const currentGen = state.generations.get(key)
      if (currentGen !== undefined && currentGen !== entry.generation) {
        state.generations.delete(key)
      }
    }
    // Do not resolve the abort promise on successful completion; waiters
    // that race `existing.promise` against it would otherwise see the abort
    // win for a happy-path exit. The entry becomes unreachable once inFlight
    // drops it, so the pending abort promise will be garbage-collected.
  })
  state.inFlight.set(key, entry)
  return entry.promise
}

function createEntry(state: BootstrapSyncState, indexName: string, partitionId: number, key: string): BootstrapEntry {
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

async function executeBootstrapSync(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS
  const deadline = Date.now() + deadlineMs
  const key = entryKey(indexName, partitionId)

  const abortCheck = (): boolean => {
    const currentGeneration = state.generations.get(key) ?? 0
    if (currentGeneration !== entry.generation) {
      entry.aborted = true
    }
    return entry.aborted
  }

  const schemaResult = await fetchSchemaAndPrepare(entry, indexName, primaryNodeId, deps)
  if (schemaResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if (schemaResult === null) {
    return false
  }
  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  if (Date.now() >= deadline) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before fetching snapshot', {
        indexName,
        deadlineMs,
      }),
    )
    return false
  }

  const targetsResult = await resolveTransportTargets(indexName, primaryNodeId, deps.resolveNodeTargets)
  if (targetsResult instanceof NarsilError) {
    surfaceError(deps, indexName, primaryNodeId, targetsResult)
    return false
  }

  const fetchDeps = { transport: deps.transport, sourceNodeId: deps.sourceNodeId }
  const fetchResult = await fetchSnapshotFromAnyTarget(
    indexName,
    primaryNodeId,
    targetsResult,
    deadline,
    fetchDeps,
    abortCheck,
  )
  if (!fetchResult.ok) {
    if (fetchResult.code === ErrorCodes.SNAPSHOT_SYNC_ABORTED) {
      surfaceAborted(deps, indexName, primaryNodeId)
      return false
    }
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(fetchResult.code, fetchResult.message, {
        indexName,
        primaryNodeId,
        ...fetchResult.details,
      }),
    )
    return false
  }

  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const restoreSucceeded = await applyRestore(
    state,
    entry,
    indexName,
    primaryNodeId,
    fetchResult.bytes,
    schemaResult,
    deadline,
    deps,
  )
  if (!restoreSucceeded) {
    return false
  }

  // Defense-in-depth: an eviction may have slipped in between applyRestore's
  // final generation check and this point (there are no awaits in between
  // today, but a future edit could add one). Re-check before mutating the
  // shared completed set so a drained worker never revives a stale slot.
  if (abortCheck()) {
    if (!anotherBootstrapOwnsKey(state, key, entry)) {
      await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    }
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  state.completed.add(key)
  return true
}

function anotherBootstrapOwnsKey(state: BootstrapSyncState, key: string, self: BootstrapEntry): boolean {
  const current = state.inFlight.get(key)
  if (current === undefined) {
    return false
  }
  return current !== self
}

async function fetchSchemaAndPrepare(
  entry: BootstrapEntry,
  indexName: string,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<SchemaDefinition | null | 'aborted'> {
  const dropError = await dropExistingIndex(deps.engine, indexName, primaryNodeId)
  if (dropError !== null) {
    surfaceError(deps, indexName, primaryNodeId, dropError)
    return null
  }

  if (entry.aborted) {
    return 'aborted'
  }

  const schemaResult = await loadCoordinatorSchema(deps.coordinator, indexName, primaryNodeId, entry.abortPromise)
  if (schemaResult === 'aborted') {
    return 'aborted'
  }
  if ('error' in schemaResult) {
    surfaceError(deps, indexName, primaryNodeId, schemaResult.error)
    return null
  }
  return schemaResult.schema
}

async function applyRestore(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  primaryNodeId: string,
  bytes: Uint8Array,
  coordinatorSchema: SchemaDefinition,
  deadline: number,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before restore', {
        indexName,
      }),
    )
    return false
  }

  const key = entryKey(indexName, entry.partitionId)
  const generationBeforeRestore = state.generations.get(key) ?? 0
  if (generationBeforeRestore !== entry.generation || entry.aborted) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const restoreError = await executeEngineRestore(deps.engine, indexName, primaryNodeId, bytes, remainingMs)
  if (restoreError !== null) {
    surfaceError(deps, indexName, primaryNodeId, restoreError)
    return false
  }

  const generationAfterRestore = state.generations.get(key) ?? 0
  if (generationAfterRestore !== entry.generation || entry.aborted) {
    // Our bootstrap was aborted, but another bootstrap may already be racing
    // us for the same index (M-new-2 allows a fresh runBootstrapSync to
    // start immediately after eviction). Dropping the index here would
    // destroy that bootstrap's restored data. Defer to the takeover.
    if (!anotherBootstrapOwnsKey(state, key, entry)) {
      await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    }
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const schemaError = validateRestoredSchema(deps.engine, indexName, primaryNodeId, coordinatorSchema)
  if (schemaError !== null) {
    await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    surfaceError(deps, indexName, primaryNodeId, schemaError)
    return false
  }

  return true
}
