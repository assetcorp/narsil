import { resolveIndexAnalysis } from '../../analysis/registry'
import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { PartitionManager } from '../../partitioning/manager'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateSchema, validateVectorPromotion } from '../../schema/validator'
import { packIndexSnapshotEnvelope, unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import { hasNrslMagic } from '../../serialization/header'
import { deserializePayloadV1 } from '../../serialization/payload-v1'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { VectorIndexPayload } from '../../vector/vector-index'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { StaleIndex } from '../analysis-rebuild'
import type { IndexRegistryEntry } from '../core'
import type { DurabilityIntegration } from '../durability-integration'
import type { IndexStateCoordinator } from '../index-state'
import { restoredConfigFields, restoredEmbedding, type SnapshotEnvelope } from './restore-config'

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

  const config = entry.config
  const bm25 = config.bm25
  const { encode } = await import('@msgpack/msgpack')
  const payload = encode({
    version: 2,
    schema: config.schema,
    language: entry.language.name,
    analysisRevision: entry.language.revision,
    ...(typeof config.tokenizer === 'string' ? { tokenizer: config.tokenizer } : {}),
    ...(typeof config.stopWords === 'string' ? { stopWords: config.stopWords } : {}),
    ...(config.stopWords instanceof Set ? { stopWordList: [...config.stopWords].sort(compareCodePoints) } : {}),
    ...(bm25 !== undefined
      ? {
          bm25: {
            ...(bm25.k1 !== undefined ? { k1: bm25.k1 } : {}),
            ...(bm25.b !== undefined ? { b: bm25.b } : {}),
          },
        }
      : {}),
    surfaceForms: config.surfaceForms !== false,
    ...(config.partitions !== undefined ? { partitionConfig: config.partitions } : {}),
    ...(config.defaultScoring !== undefined ? { defaultScoring: config.defaultScoring } : {}),
    ...(config.trackPositions !== undefined ? { trackPositions: config.trackPositions } : {}),
    ...(config.strict !== undefined ? { strict: config.strict } : {}),
    ...(config.required !== undefined ? { required: config.required } : {}),
    ...(config.vectorPromotion !== undefined ? { vectorPromotion: config.vectorPromotion } : {}),
    ...(config.embedding !== undefined
      ? {
          embedding: {
            fields: config.embedding.fields,
            ...(entry.embeddingAdapterName !== null ? { adapter: entry.embeddingAdapterName } : {}),
          },
        }
      : {}),
    partitions: partitionBuffers,
    vectorIndexes: vectorPayloads,
  })
  return packIndexSnapshotEnvelope(payload)
}

export interface RestoreDeps {
  executor: Executor & DirectExecutorExtensions
  indexRegistry: Map<string, IndexRegistryEntry>
  getVectorFieldPaths: (schema: SchemaDefinition) => Set<string>
  dropIndex: (name: string) => Promise<void>
  requireManager: (name: string) => PartitionManager
  durability: DurabilityIntegration | null
  embeddingAdapters: Map<string, EmbeddingAdapter>
  defaultEmbeddingAdapter: EmbeddingAdapter | null
  markAnalysisStale: (index: StaleIndex) => void
  clearAnalysisStale: (indexName: string) => void
  indexState: Pick<IndexStateCoordinator, 'registerOpen' | 'acquire' | 'forget'>
}

export async function restoreFromSnapshot(indexName: string, data: Uint8Array, deps: RestoreDeps): Promise<void> {
  if (!(data instanceof Uint8Array)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Snapshot data must be a Uint8Array')
  }

  const payloadBytes = hasNrslMagic(data) ? await unpackIndexSnapshotEnvelope(data) : data

  const { decode } = await import('@msgpack/msgpack')
  let decoded: unknown
  try {
    decoded = decode(payloadBytes)
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Snapshot data is not a Narsil snapshot: ${err instanceof Error ? err.message : String(err)}`,
      { bytes: data.length },
    )
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Snapshot data does not hold a snapshot envelope', {
      bytes: data.length,
    })
  }

  const envelope = decoded as SnapshotEnvelope

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

  const configFields = restoredConfigFields(envelope)
  const embedding = restoredEmbedding(envelope.embedding)

  const language = getLanguage(envelope.language)
  const schema = envelope.schema as SchemaDefinition
  validateSchema(schema)
  validateVectorPromotion(configFields.vectorPromotion)
  if (configFields.required !== undefined && configFields.required.length > 0) {
    validateRequiredFieldsInSchema(configFields.required, schema)
  }

  const indexConfig: IndexConfig = {
    schema,
    language: envelope.language,
    ...configFields,
    ...(embedding !== undefined
      ? {
          embedding: {
            fields: embedding.fields,
            ...(embedding.adapter !== undefined ? { adapter: embedding.adapter } : {}),
          },
        }
      : {}),
  }
  resolveIndexAnalysis(indexConfig)

  const adapterName = embedding?.adapter ?? null
  let embeddingAdapter: EmbeddingAdapter | null = null
  if (embedding !== undefined) {
    const candidate =
      adapterName !== null ? (deps.embeddingAdapters.get(adapterName) ?? null) : deps.defaultEmbeddingAdapter
    if (candidate) {
      validateEmbeddingConfig({ fields: embedding.fields, adapter: candidate }, schema, undefined)
      embeddingAdapter = candidate
    }
  }

  if (deps.indexRegistry.has(indexName)) {
    await deps.dropIndex(indexName)
  }

  const storedRevision = typeof envelope.analysisRevision === 'string' ? envelope.analysisRevision : null
  deps.clearAnalysisStale(indexName)
  if (storedRevision !== language.revision) {
    deps.markAnalysisStale({
      indexName,
      language: language.name,
      storedRevision,
      currentRevision: language.revision,
    })
  }

  deps.executor.createIndex(indexName, indexConfig, language)
  const vectorFieldPaths = deps.getVectorFieldPaths(schema)
  deps.indexRegistry.set(indexName, {
    config: indexConfig,
    language,
    embeddingAdapter,
    embeddingAdapterName: adapterName,
    vectorFieldPaths,
    indexUuid: null,
    heldPartitions: null,
    documentCount: 0,
    partitionCount: envelope.partitions.length,
  })
  await deps.indexState.registerOpen(indexName)
  const release = await deps.indexState.acquire(indexName, false)

  try {
    const manager = deps.requireManager(indexName)

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
    const entry = deps.indexRegistry.get(indexName)
    if (entry !== undefined) {
      entry.documentCount = manager.countDocuments()
      entry.partitionCount = manager.partitionCount
    }

    if (deps.durability) {
      for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
        for (const docId of manager.getPartition(partitionId).docIds()) {
          const document = manager.get(docId)
          if (document !== undefined) {
            await deps.durability.recordInsertOrUpdate(indexName, docId, document, noopApply)
          }
        }
      }
      await deps.durability.manager.persistMetadata(indexName)
      await deps.durability.manager.checkpoint(indexName)
    }
  } catch (err) {
    try {
      deps.executor.dropIndex(indexName)
    } catch (_) {}
    deps.indexRegistry.delete(indexName)
    deps.indexState.forget(indexName)
    if (deps.durability) {
      await deps.durability.manager.removeIndex(indexName).catch(() => undefined)
    }
    throw err
  } finally {
    release()
  }
}

function noopApply(): void {}
