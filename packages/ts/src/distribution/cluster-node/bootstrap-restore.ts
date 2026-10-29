import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import { validateSchema } from '../../schema/validator'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import { getClusterIndexConfig } from '../cluster/index-metadata'
import type { ClusterCoordinator } from '../coordinator/types'
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

export async function loadCoordinatorIndexConfig(
  coordinator: ClusterCoordinator,
  indexName: string,
  primaryNodeId: string,
  abortPromise: Promise<typeof ABORT_SENTINEL>,
): Promise<{ config: IndexConfig } | { error: NarsilError } | 'aborted'> {
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

  let validSchema: SchemaDefinition
  try {
    validSchema = validateSchema(schema)
  } catch (err) {
    if (!(err instanceof NarsilError)) throw err
    return {
      error: new NarsilError(err.code, `coordinator schema for index '${indexName}' is invalid: ${err.message}`, {
        ...err.details,
        indexName,
        primaryNodeId,
      }),
    }
  }

  try {
    const winner = await Promise.race([getClusterIndexConfig(coordinator, indexName, validSchema), abortPromise])
    if (winner === ABORT_SENTINEL) {
      return 'aborted'
    }
    return { config: winner }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return {
      error: new NarsilError(
        err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SCHEMA_UNAVAILABLE,
        `failed to read the coordinator index metadata for '${indexName}': ${cause}`,
        { indexName, primaryNodeId, cause },
      ),
    }
  }
}
