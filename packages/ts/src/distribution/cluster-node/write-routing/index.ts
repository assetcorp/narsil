import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { AnyDocument, IndexConfig, InsertOptions } from '../../../types/schema'
import {
  type IndexMetadata,
  indexConfigKey,
  MAX_PARTITION_COUNT,
  putIndexMetadata,
  validateIndexName,
} from '../../cluster/index-metadata'
import type { AllocationConstraints, ClusterCoordinator } from '../../coordinator/types'
import { DEFAULT_CREATE_INDEX_WAIT_MS, waitForServingAllocation } from '../allocation-wait'
import type { CreateIndexOptions } from '../types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from '../types'
import { resolvePrimaryAssignment } from './assignment'
import { forwardInsertToRemote, forwardRemoveToRemote, forwardUpdateToRemote } from './forwarding'
import { applyPrimaryInsert, applyPrimaryRemove, applyPrimaryUpdate } from './primary-writes'
import type { WriteRoutingDeps } from './types'

export { resolvePartitionId } from './assignment'
export { routeInsertBatch, routeRemoveBatch, routeUpdateBatch } from './batches'
export { applyForwardedBatch } from './forward-batch'
export { applyForwardedWrite } from './primary-writes'
export type { WriteRoutingDeps } from './types'

const MAX_REPLICATION_FACTOR = 255

function validateCreateIndexOptions(partitionCount: number, replicationFactor: number): void {
  if (!Number.isInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_PARTITION_COUNT) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `partitionCount must be an integer between 1 and ${MAX_PARTITION_COUNT}, received ${partitionCount}`,
      { partitionCount },
    )
  }

  if (!Number.isInteger(replicationFactor) || replicationFactor < 0 || replicationFactor > MAX_REPLICATION_FACTOR) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `replicationFactor must be an integer between 0 and ${MAX_REPLICATION_FACTOR}, received ${replicationFactor}`,
      { replicationFactor },
    )
  }
}

/** The part of the local engine an index creation needs, including the drop
 * a half-finished creation takes its own copy back with. */
interface IndexCreatingEngine {
  createIndexWithUuid(name: string, config: IndexConfig, indexUuid?: string): Promise<void>
  dropIndex(name: string): Promise<void>
}

export async function routeCreateIndex(
  name: string,
  config: IndexConfig,
  options: CreateIndexOptions | undefined,
  coordinator: ClusterCoordinator,
  engine: IndexCreatingEngine,
): Promise<void> {
  validateIndexName(name)

  const partitionCount = options?.partitionCount ?? DEFAULT_PARTITION_COUNT
  const replicationFactor = options?.replicationFactor ?? DEFAULT_REPLICATION_FACTOR
  validateCreateIndexOptions(partitionCount, replicationFactor)

  const constraints: AllocationConstraints = {
    zoneAwareness: false,
    zoneAttribute: 'zone',
    maxShardsPerNode: null,
  }

  const metadata: IndexMetadata = {
    indexUuid: generateId(),
    indexName: name,
    partitionCount,
    replicationFactor,
    constraints,
  }

  const stored = await putIndexMetadata(coordinator, metadata)
  if (!stored) {
    throw new NarsilError(
      ErrorCodes.INDEX_ALREADY_EXISTS,
      `Index '${name}' already exists in the cluster or a partial creation is pending`,
      { indexName: name },
    )
  }

  try {
    await engine.createIndexWithUuid(
      name,
      { ...config, partitions: { ...config.partitions, maxPartitions: partitionCount } },
      metadata.indexUuid,
    )
    await coordinator.putSchema(name, config.schema)
  } catch (createErr) {
    const cleanupError = await withdrawPartialIndex(name, coordinator, engine)
    if (cleanupError !== null) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `Index creation for '${name}' failed and the withdrawal of its cluster metadata also failed. The index may be in a partial state and require manual intervention.`,
        {
          indexName: name,
          createError: createErr instanceof Error ? createErr.message : String(createErr),
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
      )
    }

    throw createErr
  }

  await waitForServingAllocation(
    coordinator,
    name,
    partitionCount,
    options?.waitForServingMs ?? DEFAULT_CREATE_INDEX_WAIT_MS,
  )
}

/**
 * Takes back everything a half-finished creation left behind, so the name is
 * free again, no controller allocates partitions for an index no node holds,
 * and no node keeps a copy the cluster never claimed. The metadata goes first,
 * because an empty value there counts as absent and unblocks the next
 * creation; the schema follows, because its presence alone is what drives
 * allocation; and the local copy goes last.
 *
 * @param name - The index whose creation failed.
 * @param coordinator - The coordinator holding the published state.
 * @param engine - The local engine that may already hold the copy.
 * @returns The failure that stopped the withdrawal, or null when it finished.
 */
async function withdrawPartialIndex(
  name: string,
  coordinator: ClusterCoordinator,
  engine: IndexCreatingEngine,
): Promise<unknown> {
  try {
    const currentBytes = await coordinator.get(indexConfigKey(name))
    if (currentBytes !== null && currentBytes.byteLength > 0) {
      await coordinator.compareAndSet(indexConfigKey(name), currentBytes, new Uint8Array(0))
    }
    await coordinator.dropSchema(name)
    await dropLocalCopy(name, engine)
    return null
  } catch (cleanupError) {
    return cleanupError
  }
}

/** Drops the copy a failed creation may have left on this node, treating an
 * absent one as nothing to do, because the creation may have failed before it. */
async function dropLocalCopy(name: string, engine: IndexCreatingEngine): Promise<void> {
  try {
    await engine.dropIndex(name)
  } catch (dropError) {
    if (dropError instanceof NarsilError && dropError.code === ErrorCodes.INDEX_NOT_FOUND) {
      return
    }
    throw dropError
  }
}

export async function routeDropIndex(name: string, coordinator: ClusterCoordinator, engine: Narsil): Promise<void> {
  validateIndexName(name)

  const metadataKey = indexConfigKey(name)
  const metadataBytes = await coordinator.get(metadataKey)
  const hasClusterMetadata = metadataBytes !== null && metadataBytes.byteLength > 0
  const schema = await coordinator.getSchema(name)

  if (!hasClusterMetadata && schema === null) {
    return engine.dropIndex(name)
  }

  if (hasClusterMetadata) {
    const cleared = await coordinator.compareAndSet(metadataKey, metadataBytes, new Uint8Array(0))
    if (!cleared) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `Index '${name}' changed while it was being dropped; retry the drop`,
        { indexName: name },
      )
    }
  }

  await coordinator.dropSchema(name)
}

export async function routeInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<string> {
  const resolvedDocId = docId ?? generateId()
  const resolution = await resolvePrimaryAssignment(indexName, resolvedDocId, deps, false)

  if (resolution === null) {
    return deps.engine.insert(indexName, document, resolvedDocId, options)
  }

  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryInsert(
      indexName,
      document,
      resolvedDocId,
      resolution.partitionId,
      resolution.assignment,
      deps,
      options,
    )
  }

  return forwardInsertToRemote(indexName, document, resolvedDocId, primaryNodeId, deps)
}

export async function routeRemove(indexName: string, docId: string, deps: WriteRoutingDeps): Promise<void> {
  const resolution = await resolvePrimaryAssignment(indexName, docId, deps, false)

  if (resolution === null) {
    return deps.engine.remove(indexName, docId)
  }

  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryRemove(indexName, docId, resolution.partitionId, resolution.assignment, deps)
  }

  return forwardRemoveToRemote(indexName, docId, primaryNodeId, deps)
}

export async function routeUpdate(
  indexName: string,
  docId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
): Promise<void> {
  const resolution = await resolvePrimaryAssignment(indexName, docId, deps, false)

  if (resolution === null) {
    return deps.engine.update(indexName, docId, document)
  }

  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryUpdate(indexName, docId, document, resolution.partitionId, resolution.assignment, deps)
  }

  return forwardUpdateToRemote(indexName, document, docId, primaryNodeId, deps)
}
