import { createPartitionIndex } from '../../core/partition'
import { createEngineCore, type EngineCore } from '../../engine/core'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { Narsil } from '../../narsil'
import { createNarsilFromCore } from '../../narsil'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { NarsilConfig } from '../../types/config'
import type { FieldType, IndexConfig, SchemaDefinition } from '../../types/schema'
import { MAX_PARTITION_COUNT } from '../cluster/index-metadata'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationLogEntry } from '../replication/types'

export interface ClusterLocalEngine extends Narsil {
  applyReplicationEntry(entry: ReplicationLogEntry): Promise<void>
  serializeReplicationPartition(indexName: string, partitionId: number): Promise<Uint8Array>
  restoreReplicationPartition(
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ): Promise<void>
}

export async function createClusterLocalEngine(config?: NarsilConfig): Promise<ClusterLocalEngine> {
  const core = createEngineCore(config)
  const engine = createNarsilFromCore(core, config)

  return Object.assign(engine, {
    applyReplicationEntry: (entry: ReplicationLogEntry) => applyReplicationEntry(core, entry),
    serializeReplicationPartition: (indexName: string, partitionId: number) =>
      serializeReplicationPartition(core, indexName, partitionId),
    restoreReplicationPartition: (
      indexName: string,
      partitionId: number,
      bytes: Uint8Array,
      schema: SchemaDefinition,
      partitionCount: number,
    ) => restoreReplicationPartition(core, engine, indexName, partitionId, bytes, schema, partitionCount),
  })
}

async function serializeReplicationPartition(
  core: EngineCore,
  indexName: string,
  partitionId: number,
): Promise<Uint8Array> {
  core.guardShutdown()
  return core.requireManager(indexName).serializePartitionToBytes(partitionId)
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

  const restoreIndex = await ensureReplicationIndex(core, engine, indexName, schema, partition.language, partitionCount)
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

async function applyReplicationEntry(core: EngineCore, entry: ReplicationLogEntry): Promise<void> {
  core.guardShutdown()
  const indexEntry = core.requireIndex(entry.indexName)
  const manager = core.requireManager(entry.indexName)
  const vecIndexes = manager.getVectorIndexes()

  if (entry.operation === 'INDEX') {
    applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes)
    const appliedDocument = manager.get(entry.documentId)
    if (appliedDocument !== undefined) {
      await core.orchestrator.replicateToWorkers({
        type: 'insert',
        indexName: entry.indexName,
        docId: entry.documentId,
        document: appliedDocument,
        requestId: `replicate-entry-insert-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
      })
    }
    return
  }

  applyDeleteEntry(entry, manager, vecIndexes)
  await core.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName: entry.indexName,
    docId: entry.documentId,
    requestId: `replicate-entry-remove-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
  })
}
