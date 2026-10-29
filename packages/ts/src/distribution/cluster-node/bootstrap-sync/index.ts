import { ABORT_SENTINEL, surfaceError, validateArguments } from '../bootstrap-restore'
import { DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS } from '../constants'
import { executeLiveBootstrapSync } from './live'
import { clearBootstrapSyncIndex, createEntry, entryKey } from './state'
import type { BootstrapEntry, BootstrapSyncDeps, BootstrapSyncState } from './types'

export { DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS } from '../constants'
export { clearBootstrapSyncIndex, createBootstrapSyncState, hasCompletedBootstrapSync } from './state'
export type { BootstrapSyncDeps, BootstrapSyncState } from './types'

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
    if (!(await replicaResyncRequired(indexName, partitionId, deps))) {
      return true
    }
    clearBootstrapSyncIndex(state, indexName, partitionId)
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
  })
  state.inFlight.set(key, entry)
  return entry.promise
}

async function replicaResyncRequired(
  indexName: string,
  partitionId: number,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const allocation = await deps.coordinator.getAllocation(indexName)
  const assignment = allocation?.assignments.get(partitionId)
  if (assignment === undefined) {
    return false
  }
  return (
    assignment.state === 'ACTIVE' &&
    assignment.replicas.includes(deps.sourceNodeId) &&
    !assignment.inSyncSet.includes(deps.sourceNodeId)
  )
}

export async function executeBootstrapSync(
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

  return executeLiveBootstrapSync(
    state,
    entry,
    indexName,
    partitionId,
    primaryNodeId,
    deps,
    deadlineMs,
    deadline,
    abortCheck,
  )
}
