import { ErrorCodes, NarsilError } from '../../../errors'
import type { SchemaDefinition } from '../../../types/schema'
import {
  dropExistingIndex,
  dropRestoredIndexQuietly,
  executeEngineRestore,
  loadCoordinatorSchema,
  surfaceAborted,
  surfaceError,
  validateRestoredSchema,
} from '../bootstrap-restore'
import { anotherBootstrapOwnsKey, entryKey } from './state'
import type { BootstrapEntry, BootstrapSyncDeps, BootstrapSyncState } from './types'

export async function fetchSchemaAndPrepare(
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

export async function applyRestore(
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
