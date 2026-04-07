import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import type { PartitionManager } from '../partitioning/manager'
import { validateSchema } from '../schema/validator'
import { deserializePayloadV1 } from '../serialization/payload-v1'
import { deserializePayloadV2 } from '../serialization/payload-v2'
import type { EmbeddingAdapter } from '../types/adapters'
import type { LanguageModule } from '../types/language'
import type { IndexConfig, SchemaDefinition } from '../types/schema'
import type { VectorIndexPayload } from '../vector/vector-index'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'

interface IndexRegistryEntry {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  vectorFieldPaths: Set<string>
}

export async function createSnapshot(manager: PartitionManager, entry: IndexRegistryEntry): Promise<Uint8Array> {
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

  const language = getLanguage(envelope.language)
  const schema = envelope.schema as SchemaDefinition
  validateSchema(schema)

  if (indexRegistry.has(indexName)) {
    await dropIndex(indexName)
  }

  const indexConfig: IndexConfig = { schema, language: envelope.language }
  executor.createIndex(indexName, indexConfig, language)
  const vectorFieldPaths = getVectorFieldPaths(schema)
  indexRegistry.set(indexName, { config: indexConfig, language, embeddingAdapter: null, vectorFieldPaths })

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
