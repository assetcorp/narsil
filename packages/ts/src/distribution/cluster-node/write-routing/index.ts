import { generateId } from '../../../core/id-generator'
import { bm25SetsValue } from '../../../core/scorer'
import { requireConfigurationWithinSizeLimit } from '../../../engine/snapshot/index-configuration-limit'
import { prepareConfiguredSynonyms } from '../../../engine/synonym-sets'
import { requireSurfaceFormsForPartialFields, validateBooleanOnlySettings } from '../../../engine/validation'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import type { Narsil } from '../../../narsil'
import { requireCreatableSchema, validateSchema } from '../../../schema/validator'
import { validateBM25Params } from '../../../search/bm25-params'
import type { IndexConfig } from '../../../types/schema'
import {
  type IndexMetadata,
  indexConfigKey,
  indexUuidOfStoredMetadata,
  putIndexMetadata,
  storedSynonymSetOf,
  validateIndexName,
} from '../../cluster/index-metadata'
import { type IndexSettings, indexSettingsOf, withPartitionCount } from '../../cluster/index-settings'
import { deleteSynonymSet, type SynonymSetRef, storeSynonymSet } from '../../cluster/synonym-set'
import { MAX_PARTITION_COUNT, MAX_REPLICATION_FACTOR } from '../../constants'
import type { AllocationConstraints, ClusterCoordinator } from '../../coordinator/types'
import { bm25NotReady, registeredNodesBelowBm25Tuning } from '../../query/bm25-routing'
import { waitForServingAllocation } from '../allocation-wait'
import { DEFAULT_CREATE_INDEX_WAIT_MS } from '../constants'
import { localIndexIsGone } from '../local-index-gone'
import type { CreateIndexOptions } from '../types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from '../types'

export { resolvePartitionId } from './assignment'
export { routeInsertBatch, routeRemoveBatch, routeUpdateBatch } from './batches'
export { applyForwardedBatch } from './forward-batch'
export { applyForwardedWrite } from './primary-writes'
export { routeInsert, routeRemove, routeUpdate } from './single-writes'
export type { WriteRoutingDeps } from './types'

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

interface IndexCreatingEngine {
  createIndexWithUuid(name: string, config: IndexConfig, indexUuid?: string): Promise<void>
  dropIndex(name: string): Promise<void>
}

export async function routeCreateIndex(
  name: string,
  requestedConfig: IndexConfig,
  options: CreateIndexOptions | undefined,
  coordinator: ClusterCoordinator,
  engine: IndexCreatingEngine,
  marker?: Pick<IndexSettings, 'querySuggestionsSource'>,
): Promise<void> {
  validateIndexName(name)
  const config: IndexConfig = { ...requestedConfig, schema: validateSchema(requestedConfig.schema) }
  requireCreatableSchema(config.schema)
  requireSurfaceFormsForPartialFields(config.schema, config.surfaceForms)
  validateBooleanOnlySettings(config)
  if (config.bm25 !== undefined) validateBM25Params(config.bm25, config.schema, ErrorCodes.CONFIG_INVALID)
  const setsFieldPairs = config.bm25?.fields !== undefined && bm25SetsValue({ fields: config.bm25.fields })
  if (setsFieldPairs) {
    const olderNodes = registeredNodesBelowBm25Tuning(await coordinator.listNodes())
    if (olderNodes.length > 0) throw bm25NotReady('The cluster has', olderNodes, name)
  }

  const partitionCount = options?.partitionCount ?? DEFAULT_PARTITION_COUNT
  const replicationFactor = options?.replicationFactor ?? DEFAULT_REPLICATION_FACTOR
  validateCreateIndexOptions(partitionCount, replicationFactor)
  const language = getLanguage(config.language ?? 'english')
  requireConfigurationWithinSizeLimit(withPartitionCount(config, partitionCount), language)
  const synonyms = prepareConfiguredSynonyms(config, language)

  const constraints: AllocationConstraints = {
    zoneAwareness: false,
    zoneAttribute: 'zone',
    maxShardsPerNode: null,
  }

  const indexUuid = generateId()
  const synonymSet = synonyms === null ? null : await storeSynonymSet(coordinator, indexUuid, synonyms.encoded)
  const metadata: IndexMetadata = {
    indexUuid,
    indexName: name,
    partitionCount,
    replicationFactor,
    constraints,
    settings: {
      ...indexSettingsOf(config),
      ...(synonymSet !== null ? { synonyms: synonymSet } : {}),
      ...(setsFieldPairs ? { bm25Revision: 1 } : {}),
      ...marker,
    },
  }

  const stored = await putIndexMetadata(coordinator, metadata).catch(async (err: unknown) => {
    await discardSynonymSet(coordinator, indexUuid, synonymSet)
    throw err
  })
  if (!stored) {
    await discardSynonymSet(coordinator, indexUuid, synonymSet)
    throw new NarsilError(
      ErrorCodes.INDEX_ALREADY_EXISTS,
      `Index '${name}' already exists in the cluster or a partial creation is pending`,
      { indexName: name },
    )
  }

  try {
    await engine.createIndexWithUuid(name, withPartitionCount(config, partitionCount), metadata.indexUuid)
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

async function discardSynonymSet(
  coordinator: ClusterCoordinator,
  indexUuid: string,
  synonymSet: SynonymSetRef | null,
): Promise<void> {
  if (synonymSet === null) return
  await deleteSynonymSet(coordinator, indexUuid, synonymSet).catch(() => undefined)
}

async function deleteStoredSynonymSet(coordinator: ClusterCoordinator, metadataBytes: Uint8Array): Promise<void> {
  const stored = storedSynonymSetOf(metadataBytes)
  if (stored !== null) await deleteSynonymSet(coordinator, stored.indexUuid, stored.ref)
}

async function withdrawPartialIndex(
  name: string,
  coordinator: ClusterCoordinator,
  engine: IndexCreatingEngine,
): Promise<unknown> {
  try {
    const currentBytes = await coordinator.get(indexConfigKey(name))
    if (currentBytes !== null && currentBytes.byteLength > 0) {
      if (await coordinator.compareAndSet(indexConfigKey(name), currentBytes, new Uint8Array(0))) {
        await deleteStoredSynonymSet(coordinator, currentBytes)
      }
    }
    await coordinator.dropSchema(name)
    await dropLocalCopy(name, engine)
    return null
  } catch (cleanupError) {
    return cleanupError
  }
}

async function dropLocalCopy(name: string, engine: IndexCreatingEngine): Promise<void> {
  try {
    await engine.dropIndex(name)
  } catch (dropError) {
    if (localIndexIsGone(dropError)) {
      return
    }
    throw dropError
  }
}

export interface DroppedClusterIndex {
  indexUuid: string | null
}

export async function routeDropIndex(
  name: string,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<DroppedClusterIndex | null> {
  validateIndexName(name)

  const metadataKey = indexConfigKey(name)
  const metadataBytes = await coordinator.get(metadataKey)
  const hasClusterMetadata = metadataBytes !== null && metadataBytes.byteLength > 0
  const schema = await coordinator.getSchema(name)

  if (!hasClusterMetadata && schema === null) {
    if (metadataBytes === null) {
      await engine.dropIndex(name)
      return null
    }
    try {
      if (engine.listIndexes().some(index => index.name === name)) await engine.dropIndex(name)
    } catch (dropError) {
      if (!(dropError instanceof NarsilError && dropError.code === ErrorCodes.INDEX_NOT_FOUND)) throw dropError
    }
    return { indexUuid: null }
  }

  let indexUuid: string | null = null
  if (hasClusterMetadata) {
    const cleared = await coordinator.compareAndSet(metadataKey, metadataBytes, new Uint8Array(0))
    if (!cleared) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `Index '${name}' changed while it was being dropped; retry the drop`,
        { indexName: name },
      )
    }
    indexUuid = indexUuidOfStoredMetadata(metadataBytes)
    await deleteStoredSynonymSet(coordinator, metadataBytes)
  }

  await coordinator.dropSchema(name)
  return { indexUuid }
}
