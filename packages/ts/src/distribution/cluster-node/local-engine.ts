import { createPartitionIndex } from '../../core/partition'
import { createEngineCore, type EngineCore } from '../../engine/core'
import { createEngineIndex } from '../../engine/index-lifecycle'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { Narsil } from '../../narsil'
import { createNarsilFromCore } from '../../narsil'
import {
  type PartitionQueryStats,
  runEngineListDocuments,
  runEnginePreflight,
  runEngineQuery,
  runEngineQueryStats,
  runEngineSuggest,
} from '../../narsil/reads'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'
import type { ListResult, PartitionStatsResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument, FieldType, IndexConfig, SchemaDefinition } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import { MAX_PARTITION_COUNT } from '../cluster/index-metadata'
import type { ReplicationLogEntry } from '../replication/types'
import { createHeldPartitionRecord } from './held-partitions'
import { applyLocalReplicationEntry } from './local-replication'

export interface ClusterLocalEngine extends Narsil {
  createIndexWithUuid(name: string, config: IndexConfig, indexUuid?: string): Promise<void>
  indexUuidOf(indexName: string): string | null | undefined
  stampIndexUuid(indexName: string, indexUuid: string): Promise<void>
  highestPersistedSeqNoOf(indexName: string, partitionId: number): number
  heldPartitionsOf(indexName: string): number[] | undefined
  recordHeldPartition(indexName: string, partitionId: number): Promise<void>
  forgetHeldPartition(indexName: string, partitionId: number): Promise<void>
  applyReplicationEntry(entry: ReplicationLogEntry): Promise<void>
  serializeReplicationPartition(indexName: string, partitionId: number): Promise<Uint8Array>
  restoreReplicationPartition(
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ): Promise<void>
  queryPartitions<T = AnyDocument>(
    indexName: string,
    params: QueryParams,
    partitionIds: number[],
    globalStats?: GlobalStatistics,
  ): Promise<QueryResult<T>>
  preflightPartitions(indexName: string, params: QueryParams, partitionIds: number[]): Promise<PreflightResult>
  suggestPartitions(indexName: string, params: SuggestParams, partitionIds: number[]): Promise<SuggestResult>
  listPartitions<T = AnyDocument>(indexName: string, params: ListParams, partitionIds: number[]): Promise<ListResult<T>>
  collectQueryStats(indexName: string, terms: string[], partitionIds: number[]): Promise<PartitionQueryStats>
  partitionStatsForRead(indexName: string): Promise<PartitionStatsResult[]>
}

/**
 * Builds the engine one cluster node uses for its local partitions.
 *
 * @param config - Settings for this node's engine.
 * @param hooks - Node-local cleanup called after an index checkpoint.
 * @returns The local engine, including partition-scoped cluster operations.
 */
export async function createClusterLocalEngine(
  config?: NarsilConfig,
  hooks?: {
    onIndexOpen?(indexName: string): void | Promise<void>
    onIndexClose?(indexName: string): void | Promise<void>
  },
): Promise<ClusterLocalEngine> {
  const core = createEngineCore(config, hooks)
  if (core.durability !== null) {
    await core.durability.manager.recover(config?.lifecycle !== undefined)
  }
  if (core.invalidation !== null) {
    await core.invalidation.start()
  }
  if (config?.lifecycle === undefined) await core.analysisRebuild.reviewStaleIndexes()
  const engine = createNarsilFromCore(core, config)
  const heldPartitions = createHeldPartitionRecord(core)

  return Object.assign(engine, {
    createIndexWithUuid: (name: string, indexConfig: IndexConfig, indexUuid?: string) =>
      createEngineIndex(core, config, name, indexConfig, indexUuid),
    indexUuidOf: (indexName: string) => core.indexRegistry.get(indexName)?.indexUuid,
    stampIndexUuid: (indexName: string, indexUuid: string) => stampIndexUuid(core, indexName, indexUuid),
    highestPersistedSeqNoOf: (indexName: string, partitionId: number) =>
      core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0,
    heldPartitionsOf: (indexName: string) => heldPartitions.held(indexName),
    recordHeldPartition: (indexName: string, partitionId: number) => heldPartitions.record(indexName, partitionId),
    forgetHeldPartition: (indexName: string, partitionId: number) => heldPartitions.forget(indexName, partitionId),
    applyReplicationEntry: (entry: ReplicationLogEntry) => applyLocalReplicationEntry(core, entry),
    serializeReplicationPartition: (indexName: string, partitionId: number) =>
      serializeReplicationPartition(core, indexName, partitionId),
    restoreReplicationPartition: (
      indexName: string,
      partitionId: number,
      bytes: Uint8Array,
      schema: SchemaDefinition,
      partitionCount: number,
    ) => restoreReplicationPartition(core, engine, indexName, partitionId, bytes, schema, partitionCount),
    queryPartitions: <T = AnyDocument>(
      indexName: string,
      params: QueryParams,
      partitionIds: number[],
      globalStats?: GlobalStatistics,
    ) => runEngineQuery<T>(core, indexName, params, { partitionIds, globalStats }),
    preflightPartitions: (indexName: string, params: QueryParams, partitionIds: number[]) =>
      runEnginePreflight(core, indexName, params, { partitionIds }),
    suggestPartitions: (indexName: string, params: SuggestParams, partitionIds: number[]) =>
      runEngineSuggest(core, indexName, params, partitionIds),
    listPartitions: <T = AnyDocument>(indexName: string, params: ListParams, partitionIds: number[]) =>
      runEngineListDocuments<T>(core, indexName, params, partitionIds),
    collectQueryStats: (indexName: string, terms: string[], partitionIds: number[]) =>
      runEngineQueryStats(core, indexName, terms, partitionIds),
    partitionStatsForRead: async (indexName: string) => {
      const release = await core.indexState.acquire(indexName)
      try {
        return core.requireManager(indexName).getPartitionStats()
      } finally {
        release()
      }
    },
  })
}

async function stampIndexUuid(core: EngineCore, indexName: string, indexUuid: string): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined || entry.indexUuid === indexUuid) {
    return
  }
  core.indexRegistry.set(indexName, { ...entry, indexUuid })
  if (core.durability !== null) {
    await core.durability.manager.persistMetadata(indexName)
  }
}

async function serializeReplicationPartition(
  core: EngineCore,
  indexName: string,
  partitionId: number,
): Promise<Uint8Array> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName, false)
  try {
    return core.requireManager(indexName).serializePartitionToBytes(partitionId)
  } finally {
    release()
  }
}

async function restoreReplicationPartition(
  core: EngineCore,
  engine: Narsil,
  indexName: string,
  partitionId: number,
  bytes: Uint8Array,
  schema: SchemaDefinition,
  partitionCount: number,
): Promise<void> {
  core.guardShutdown()
  validatePartitionRestoreTarget(indexName, partitionId, partitionCount)

  let partition: ReturnType<typeof deserializePayloadV2>
  try {
    partition = deserializePayloadV2(bytes)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `partition snapshot decode failed: ${cause}`, {
      indexName,
      partitionId,
      cause,
    })
  }

  validatePartitionSnapshotPayload(indexName, partitionId, partitionCount, schema, partition)
  // Dry-run deserialisation into a throwaway partition so a malformed payload
  // throws before any live state changes; mirror the target index's position
  // tracking so the validation exercises the same code path as the restore.
  const trackPositions = core.indexRegistry.get(indexName)?.config.trackPositions ?? true
  createPartitionIndex(partitionId, trackPositions).deserialize(partition, schema)

  let release = core.indexRegistry.has(indexName) ? await core.indexState.acquire(indexName, false) : null
  try {
    const restoreIndex = await ensureReplicationIndex(
      core,
      engine,
      indexName,
      schema,
      partition.language,
      partitionCount,
    )
    if (release === null) release = await core.indexState.acquire(indexName, false)
    if (restoreIndex.created) {
      await core.orchestrator.replicateToWorkers({
        type: 'createIndex',
        indexName,
        config: restoreIndex.config,
        requestId: `replicate-partition-index-${indexName}`,
      })
    }
    const manager = core.requireManager(indexName)
    manager.deserializePartition(partitionId, partition)
    await core.orchestrator.replicateToWorkers({
      type: 'deserialize',
      indexName,
      partitionId,
      data: partition,
      requestId: `replicate-partition-restore-${indexName}-${partitionId}`,
    })
  } finally {
    release?.()
  }
}

function validatePartitionRestoreTarget(indexName: string, partitionId: number, partitionCount: number): void {
  if (!Number.isInteger(partitionId) || partitionId < 0) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partitionId must be a non-negative integer', {
      indexName,
      partitionId,
    })
  }
  if (!Number.isInteger(partitionCount) || partitionCount <= 0 || partitionCount > MAX_PARTITION_COUNT) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
      `partitionCount must be an integer between 1 and ${MAX_PARTITION_COUNT}`,
      { indexName, partitionCount },
    )
  }
  if (partitionId >= partitionCount) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partitionId is outside partitionCount', {
      indexName,
      partitionId,
      partitionCount,
    })
  }
}

function validatePartitionSnapshotPayload(
  indexName: string,
  partitionId: number,
  partitionCount: number,
  schema: SchemaDefinition,
  partition: ReturnType<typeof deserializePayloadV2>,
): void {
  if (partition.indexName !== indexName) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot indexName mismatch', {
      expectedIndexName: indexName,
      receivedIndexName: partition.indexName,
    })
  }
  if (partition.partitionId !== partitionId) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot partitionId mismatch', {
      indexName,
      expectedPartitionId: partitionId,
      receivedPartitionId: partition.partitionId,
    })
  }
  if (partition.totalPartitions !== partitionCount) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot partition count mismatch', {
      indexName,
      partitionId,
      expectedPartitionCount: partitionCount,
      receivedPartitionCount: partition.totalPartitions,
    })
  }

  const expectedSchema = flattenSchema(schema)
  for (const [field, expectedType] of Object.entries(expectedSchema)) {
    if (partition.schema[field] !== expectedType) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot schema mismatch', {
        indexName,
        partitionId,
        field,
        expected: expectedType,
        received: partition.schema[field] ?? '(absent)',
      })
    }
  }
  for (const field of Object.keys(partition.schema)) {
    if (!(field in expectedSchema)) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot schema contains extra field', {
        indexName,
        partitionId,
        field,
      })
    }
  }
}

async function ensureReplicationIndex(
  core: EngineCore,
  engine: Narsil,
  indexName: string,
  schema: SchemaDefinition,
  languageName: string,
  partitionCount: number,
): Promise<{ config: IndexConfig; created: boolean }> {
  const language = getLanguage(languageName)
  const existing = core.indexRegistry.get(indexName)
  let created = false
  if (existing === undefined) {
    const indexConfig: IndexConfig = {
      schema,
      language: language.name,
      partitions: { maxPartitions: partitionCount },
    }
    try {
      await engine.createIndex(indexName, indexConfig)
      created = true
    } catch (err) {
      if (!(err instanceof NarsilError) || err.code !== ErrorCodes.INDEX_ALREADY_EXISTS) {
        throw err
      }
    }
  }

  const entry = core.requireIndex(indexName)
  if (entry.language.name !== language.name) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'partition snapshot language mismatch', {
      indexName,
      expectedLanguage: entry.language.name,
      receivedLanguage: language.name,
    })
  }
  validateExistingSchema(indexName, schema, entry.config.schema)

  const manager = core.requireManager(indexName)
  if (manager.partitionCount > partitionCount) {
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'local index has more partitions than allocation', {
      indexName,
      localPartitionCount: manager.partitionCount,
      allocationPartitionCount: partitionCount,
    })
  }
  if (entry.config.partitions === undefined) {
    entry.config.partitions = { maxPartitions: partitionCount }
  } else if ((entry.config.partitions.maxPartitions ?? manager.partitionCount) < partitionCount) {
    entry.config.partitions.maxPartitions = partitionCount
  }
  while (manager.partitionCount < partitionCount) {
    manager.addPartition()
  }

  return { config: entry.config, created }
}

function validateExistingSchema(indexName: string, expected: SchemaDefinition, actual: SchemaDefinition): void {
  const expectedSchema = flattenSchema(expected)
  const actualSchema = flattenSchema(actual)
  for (const [field, expectedType] of Object.entries(expectedSchema)) {
    if (actualSchema[field] !== expectedType) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'local index schema mismatch', {
        indexName,
        field,
        expected: expectedType,
        received: actualSchema[field] ?? '(absent)',
      })
    }
  }
  for (const field of Object.keys(actualSchema)) {
    if (!(field in expectedSchema)) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'local index schema contains extra field', {
        indexName,
        field,
      })
    }
  }
}

function flattenSchema(schema: SchemaDefinition): Record<string, string> {
  const flat: Record<string, string> = {}
  flattenSchemaInto(schema, '', flat)
  return flat
}

function flattenSchemaInto(schema: SchemaDefinition, prefix: string, flat: Record<string, string>): void {
  for (const [field, value] of Object.entries(schema)) {
    const path = prefix.length === 0 ? field : `${prefix}.${field}`
    if (isNestedSchema(value)) {
      flattenSchemaInto(value, path, flat)
      continue
    }
    flat[path] = value
  }
}

function isNestedSchema(value: FieldType | SchemaDefinition): value is SchemaDefinition {
  return typeof value === 'object' && value !== null
}
