import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { ClusterCoordinator } from '../coordinator/types'
import type { NodeTransport } from '../transport/types'
import { fetchSnapshotFromAnyTarget, withDeadline } from './bootstrap-fetch'

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000

interface BootstrapEntry {
  indexName: string
  partitionId: number
  generation: number
  promise: Promise<boolean>
  aborted: boolean
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
  const previous = state.generations.get(key) ?? 0
  state.generations.set(key, previous + 1)
  const inFlight = state.inFlight.get(key)
  if (inFlight !== undefined) {
    inFlight.aborted = true
  }
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
    return existing.promise
  }

  const startGeneration = state.generations.get(key) ?? 0
  const entry: BootstrapEntry = {
    indexName,
    partitionId,
    generation: startGeneration,
    promise: Promise.resolve(false),
    aborted: false,
  }
  entry.promise = executeBootstrapSync(state, entry, indexName, partitionId, primaryNodeId, deps).finally(() => {
    const current = state.inFlight.get(key)
    if (current === entry) {
      state.inFlight.delete(key)
    }
  })
  state.inFlight.set(key, entry)
  return entry.promise
}

function validateArguments(indexName: string, partitionId: number, primaryNodeId: string): NarsilError | null {
  if (typeof indexName !== 'string' || indexName.length === 0) {
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, 'indexName must be a non-empty string', {
      indexName,
    })
  }
  if (!Number.isInteger(partitionId) || partitionId < 0) {
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, 'partitionId must be a non-negative integer', {
      indexName,
      partitionId,
    })
  }
  if (typeof primaryNodeId !== 'string' || primaryNodeId.length === 0) {
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, 'primaryNodeId must be a non-empty string', {
      indexName,
    })
  }
  return null
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

  const schemaReady = await ensureSchemaFetched(indexName, primaryNodeId, deps)
  if (!schemaReady) {
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

  const targets = await resolveTargets(indexName, primaryNodeId, deps)
  if (targets === null) {
    return false
  }

  const fetchDeps = { transport: deps.transport, sourceNodeId: deps.sourceNodeId }
  const fetchResult = await fetchSnapshotFromAnyTarget(
    indexName,
    primaryNodeId,
    targets,
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

  const restoreSucceeded = await applyRestore(indexName, primaryNodeId, fetchResult.bytes, deadline, deps)
  if (!restoreSucceeded) {
    return false
  }

  const currentGeneration = state.generations.get(key) ?? 0
  if (currentGeneration !== entry.generation || entry.aborted) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  state.completed.add(key)
  return true
}

async function resolveTargets(
  indexName: string,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<string[] | null> {
  let targets: string[]
  try {
    targets = await deps.resolveNodeTargets(primaryNodeId)
  } catch (err) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS,
        `resolveNodeTargets failed: ${err instanceof Error ? err.message : String(err)}`,
        { indexName, primaryNodeId, cause: err instanceof Error ? err.message : String(err) },
      ),
    )
    return null
  }

  if (targets.length === 0) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS,
        `no transport targets resolved for primary '${primaryNodeId}'`,
        { indexName, primaryNodeId },
      ),
    )
    return null
  }

  return targets
}

async function applyRestore(
  indexName: string,
  primaryNodeId: string,
  bytes: Uint8Array,
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

  try {
    await withDeadline(deps.engine.restore(indexName, bytes), remainingMs, indexName, 'restore')
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.SNAPSHOT_SYNC_TIMEOUT) {
      surfaceError(deps, indexName, primaryNodeId, err)
      return false
    }
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
        `engine.restore failed: ${err instanceof Error ? err.message : String(err)}`,
        { indexName, primaryNodeId, cause: err instanceof Error ? err.message : String(err) },
      ),
    )
    return false
  }

  return true
}

async function ensureSchemaFetched(
  indexName: string,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const existing = deps.engine.listIndexes().find(idx => idx.name === indexName)
  if (existing !== undefined) {
    try {
      await deps.engine.dropIndex(indexName)
    } catch (err) {
      surfaceError(
        deps,
        indexName,
        primaryNodeId,
        new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
          `engine.dropIndex failed before restore: ${err instanceof Error ? err.message : String(err)}`,
          { indexName, primaryNodeId, cause: err instanceof Error ? err.message : String(err) },
        ),
      )
      return false
    }
    return true
  }

  let schema: Awaited<ReturnType<ClusterCoordinator['getSchema']>>
  try {
    schema = await deps.coordinator.getSchema(indexName)
  } catch (err) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
        `coordinator.getSchema failed: ${err instanceof Error ? err.message : String(err)}`,
        { indexName, primaryNodeId, cause: err instanceof Error ? err.message : String(err) },
      ),
    )
    return false
  }

  if (schema === null) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
        `coordinator has no schema for index '${indexName}'`,
        { indexName, primaryNodeId },
      ),
    )
    return false
  }

  return true
}

function surfaceError(deps: BootstrapSyncDeps, indexName: string, primaryNodeId: string, error: NarsilError): void {
  if (deps.onError === undefined) {
    return
  }
  const wrapped = new NarsilError(
    ErrorCodes.NODE_BOOTSTRAP_FAILED,
    `Bootstrap sync failed for index '${indexName}': ${error.message}`,
    {
      indexName,
      primaryNodeId,
      innerCode: error.code,
      ...error.details,
    },
  )
  deps.onError(wrapped)
}

function surfaceAborted(deps: BootstrapSyncDeps, indexName: string, primaryNodeId: string): void {
  if (deps.onError === undefined) {
    return
  }
  deps.onError(
    new NarsilError(ErrorCodes.SNAPSHOT_SYNC_ABORTED, `bootstrap sync aborted for index '${indexName}'`, {
      indexName,
      primaryNodeId,
    }),
  )
}
