import type { EngineCore } from '../../engine/core'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { Narsil } from '../../narsil'
import type { FieldType, IndexConfig, SchemaDefinition } from '../../types/schema'
import { withPartitionCount } from '../cluster/index-settings'

function isNestedSchema(value: FieldType | SchemaDefinition): value is SchemaDefinition {
  return typeof value === 'object' && value !== null
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

export function flattenSchema(schema: SchemaDefinition): Record<string, string> {
  const flat: Record<string, string> = {}
  flattenSchemaInto(schema, '', flat)
  return flat
}

export function requireSameFlatSchema(
  indexName: string,
  expected: Record<string, string>,
  actual: Record<string, string>,
  what: string,
): void {
  for (const [field, expectedType] of Object.entries(expected)) {
    if (actual[field] !== expectedType) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `${what} schema mismatch`, {
        indexName,
        field,
        expected: expectedType,
        received: actual[field] ?? '(absent)',
      })
    }
  }
  for (const field of Object.keys(actual)) {
    if (!(field in expected)) {
      throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `${what} schema contains extra field`, {
        indexName,
        field,
      })
    }
  }
}

export async function ensureReplicationIndex(
  core: EngineCore,
  engine: Narsil,
  indexName: string,
  coordinatorConfig: IndexConfig,
  languageName: string,
  partitionCount: number,
): Promise<{ config: IndexConfig; created: boolean }> {
  const language = getLanguage(languageName)
  const existing = core.indexRegistry.get(indexName)
  let created = false
  if (existing === undefined) {
    const indexConfig = withPartitionCount(
      { ...coordinatorConfig, language: coordinatorConfig.language ?? language.name },
      partitionCount,
    )
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
  requireSameFlatSchema(
    indexName,
    flattenSchema(coordinatorConfig.schema),
    flattenSchema(entry.config.schema),
    'local index',
  )

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
