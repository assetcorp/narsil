import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'
import type { ClusterCoordinator } from '../coordinator/types'
import { withDeadline } from './bootstrap-fetch'
import { diffSchemas, type SchemaDiffEntry } from './schema-diff'

export const ABORT_SENTINEL = Symbol('bootstrap-sync-aborted')

export interface SurfaceErrorDeps {
  onError?: (error: unknown) => void
}

export function validateArguments(indexName: string, partitionId: number, primaryNodeId: string): NarsilError | null {
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

export async function resolveTransportTargets(
  indexName: string,
  primaryNodeId: string,
  resolveNodeTargets: (nodeId: string) => Promise<string[]>,
): Promise<string[] | NarsilError> {
  let targets: string[]
  try {
    targets = await resolveNodeTargets(primaryNodeId)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS, `resolveNodeTargets failed: ${cause}`, {
      indexName,
      primaryNodeId,
      cause,
    })
  }
  if (targets.length === 0) {
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_NO_TARGETS,
      `no transport targets resolved for primary '${primaryNodeId}'`,
      { indexName, primaryNodeId },
    )
  }
  return targets
}

export function surfaceError(
  deps: SurfaceErrorDeps,
  indexName: string,
  primaryNodeId: string,
  error: NarsilError,
): void {
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

export function surfaceAborted(deps: SurfaceErrorDeps, indexName: string, primaryNodeId: string): void {
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

export async function executeEngineRestore(
  engine: Narsil,
  indexName: string,
  primaryNodeId: string,
  bytes: Uint8Array,
  remainingMs: number,
): Promise<NarsilError | null> {
  try {
    await withDeadline(engine.restore(indexName, bytes), remainingMs, indexName, 'restore')
    return null
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.SNAPSHOT_SYNC_TIMEOUT) {
      return err
    }
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `engine.restore failed: ${cause}`, {
      indexName,
      primaryNodeId,
      cause,
    })
  }
}

export function validateRestoredSchema(
  engine: Narsil,
  indexName: string,
  primaryNodeId: string,
  coordinatorSchema: SchemaDefinition,
): NarsilError | null {
  let restoredSchema: SchemaDefinition
  try {
    restoredSchema = engine.getStats(indexName).schema
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
      `failed to read restored schema for '${indexName}': ${cause}`,
      { indexName, primaryNodeId, reason: 'schema lookup failed', cause },
    )
  }

  const differences: SchemaDiffEntry[] = diffSchemas(coordinatorSchema, restoredSchema)
  if (differences.length === 0) {
    return null
  }

  return new NarsilError(
    ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
    `restored snapshot schema disagrees with coordinator schema for '${indexName}'`,
    {
      indexName,
      primaryNodeId,
      reason: 'schema mismatch',
      differences,
    },
  )
}

/**
 * Drop the restored index, surfacing any cleanup failure through onError
 * under a dedicated code so operators can see when cleanup is stuck.
 * Still best-effort: the function never throws back to the caller, which is
 * already handling a primary failure.
 *
 * INDEX_NOT_FOUND is expected (another drop raced us) and stays silent.
 */
export async function dropRestoredIndexQuietly(
  engine: Narsil,
  indexName: string,
  deps: SurfaceErrorDeps = {},
): Promise<void> {
  try {
    const existing = engine.listIndexes().find(idx => idx.name === indexName)
    if (existing === undefined) {
      return
    }
    await engine.dropIndex(indexName)
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.INDEX_NOT_FOUND) {
      return
    }
    if (deps.onError === undefined) {
      return
    }
    const cause = err instanceof Error ? err.message : String(err)
    deps.onError(
      new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_RESTORE_CLEANUP_FAILED,
        `failed to drop restored index '${indexName}' after bootstrap cleanup: ${cause}`,
        { indexName, cause },
      ),
    )
  }
}

export async function loadCoordinatorSchema(
  coordinator: ClusterCoordinator,
  indexName: string,
  primaryNodeId: string,
  abortPromise: Promise<typeof ABORT_SENTINEL>,
): Promise<{ schema: SchemaDefinition } | { error: NarsilError } | 'aborted'> {
  let schema: SchemaDefinition | null
  try {
    const winner = await Promise.race([coordinator.getSchema(indexName), abortPromise])
    if (winner === ABORT_SENTINEL) {
      return 'aborted'
    }
    schema = winner as SchemaDefinition | null
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return {
      error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE, `coordinator.getSchema failed: ${cause}`, {
        indexName,
        primaryNodeId,
        cause,
      }),
    }
  }

  if (schema === null) {
    return {
      error: new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
        `coordinator has no schema for index '${indexName}'`,
        { indexName, primaryNodeId },
      ),
    }
  }

  return { schema }
}

export async function dropExistingIndex(
  engine: Narsil,
  indexName: string,
  primaryNodeId: string,
): Promise<NarsilError | null> {
  try {
    const existing = engine.listIndexes().find(idx => idx.name === indexName)
    if (existing === undefined) {
      return null
    }
    await engine.dropIndex(indexName)
    return null
  } catch (err) {
    // TOCTOU: another bootstrap path (e.g. cleanupRemovedPartition) may drop
    // the index between listIndexes() and the awaited dropIndex(). Treat
    // INDEX_NOT_FOUND as success; the post-condition we care about (no
    // existing index) is already satisfied. Mirrors cleanupRemovedPartition.
    if (err instanceof NarsilError && err.code === ErrorCodes.INDEX_NOT_FOUND) {
      return null
    }
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
      `engine.dropIndex failed before restore: ${cause}`,
      { indexName, primaryNodeId, cause },
    )
  }
}
