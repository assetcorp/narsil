import { resolveIndexAnalysis } from '../analysis/registry'
import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import type { PartitionManager } from '../partitioning/manager'
import { validateSchema } from '../schema/validator'
import { deserializePayloadV1 } from '../serialization/payload-v1'
import { deserializePayloadV2 } from '../serialization/payload-v2'
import type { IndexConfig, SchemaDefinition } from '../types/schema'
import type { VectorIndexPayload } from '../vector/vector-index'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import type { IndexRegistryEntry } from './core'

export async function createSnapshot(manager: PartitionManager, entry: IndexRegistryEntry): Promise<Uint8Array> {
  if (entry.config.tokenizer !== undefined && typeof entry.config.tokenizer !== 'string') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A snapshot persists no code, so the index tokenizer must be a name registered with registerTokenizer',
    )
  }
  if (typeof entry.config.stopWords === 'function') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A snapshot persists no code, so the index stop words must be a name registered with registerStopWords',
    )
  }
  const partitionBuffers: Uint8Array[] = []
  for (let i = 0; i < manager.partitionCount; i++) {
    partitionBuffers.push(manager.serializePartitionToBytes(i))
  }

  const snapshotVecIndexes = manager.getVectorIndexes()
  const vectorPayloads: Record<string, VectorIndexPayload> = {}
  for (const [fieldPath, vecIndex] of snapshotVecIndexes) {
    vectorPayloads[fieldPath] = vecIndex.serialize()
  }

  const { encode } = await import('@msgpack/msgpack')
  return encode({
    version: 2,
    schema: entry.config.schema,
    language: entry.language.name,
    ...(typeof entry.config.tokenizer === 'string' ? { tokenizer: entry.config.tokenizer } : {}),
    ...(typeof entry.config.stopWords === 'string' ? { stopWords: entry.config.stopWords } : {}),
    partitions: partitionBuffers,
    vectorIndexes: vectorPayloads,
  })
}

export async function restoreFromSnapshot(
  indexName: string,
  data: Uint8Array,
  executor: Executor & DirectExecutorExtensions,
  indexRegistry: Map<string, IndexRegistryEntry>,
  getVectorFieldPaths: (schema: SchemaDefinition) => Set<string>,
  dropIndex: (name: string) => Promise<void>,
  requireManager: (name: string) => PartitionManager,
): Promise<void> {
  if (!(data instanceof Uint8Array)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Snapshot data must be a Uint8Array')
  }

  const { decode } = await import('@msgpack/msgpack')
  const envelope = decode(data) as {
    version?: number
    schema?: Record<string, string>
    language?: string
    tokenizer?: unknown
    stopWords?: unknown
    partitions?: Uint8Array[]
    vectorIndexes?: Record<string, VectorIndexPayload>
  }

  if (envelope.version !== 1 && envelope.version !== 2) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Unsupported snapshot version: ${envelope.version}. Expected version 1 or 2`,
      { version: envelope.version },
    )
  }

  if (!envelope.schema || typeof envelope.schema !== 'object') {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing or invalid schema')
  }

  if (!envelope.language || typeof envelope.language !== 'string') {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing or invalid language')
  }

  if (!Array.isArray(envelope.partitions)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: missing partitions')
  }

  if (envelope.tokenizer !== undefined && typeof envelope.tokenizer !== 'string') {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: tokenizer must be a name')
  }

  if (envelope.stopWords !== undefined && typeof envelope.stopWords !== 'string') {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Invalid snapshot: stopWords must be a name')
  }

  const language = getLanguage(envelope.language)
  const schema = envelope.schema as SchemaDefinition
  validateSchema(schema)

  const indexConfig: IndexConfig = {
    schema,
    language: envelope.language,
    ...(typeof envelope.tokenizer === 'string' ? { tokenizer: envelope.tokenizer } : {}),
    ...(typeof envelope.stopWords === 'string' ? { stopWords: envelope.stopWords } : {}),
  }
  resolveIndexAnalysis(indexConfig)

  if (indexRegistry.has(indexName)) {
    await dropIndex(indexName)
  }

  executor.createIndex(indexName, indexConfig, language)
  const vectorFieldPaths = getVectorFieldPaths(schema)
  indexRegistry.set(indexName, {
    config: indexConfig,
    language,
    embeddingAdapter: null,
    embeddingAdapterName: null,
    vectorFieldPaths,
  })

  try {
    const manager = requireManager(indexName)

    while (manager.partitionCount < envelope.partitions.length) {
      manager.addPartition()
    }

    const deserializePartitionPayload = envelope.version === 2 ? deserializePayloadV2 : deserializePayloadV1

    for (let i = 0; i < envelope.partitions.length; i++) {
      const partition = deserializePartitionPayload(envelope.partitions[i])
      manager.deserializePartition(i, partition)
    }

    if (envelope.vectorIndexes) {
      const restoreVecIndexes = manager.getVectorIndexes()
      for (const [fieldPath, payload] of Object.entries(envelope.vectorIndexes)) {
        const vecIndex = restoreVecIndexes.get(fieldPath)
        if (vecIndex) {
          vecIndex.deserialize(payload)
        }
      }
    }
  } catch (err) {
    try {
      executor.dropIndex(indexName)
      indexRegistry.delete(indexName)
    } catch (_) {
      /* cleanup best-effort */
    }
    throw err
  }
}
