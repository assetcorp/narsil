import { compareCodePoints } from '../../core/ordering'
import {
  type ConfigFieldRejection,
  type RestoredEmbedding,
  readSharedConfigFields,
  restoredEmbedding,
  restoredPartitionConfig,
} from '../../engine/snapshot/restore-config'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type {
  BM25Params,
  IndexConfig,
  PartitionConfig,
  SchemaDefinition,
  ScoringMode,
  VectorIndexConfig,
} from '../../types/schema'

export interface IndexSettings {
  language: string
  tokenizer?: string
  stopWords?: string
  stopWordList?: string[]
  bm25?: BM25Params
  surfaceForms?: boolean
  defaultScoring?: ScoringMode
  trackPositions?: boolean
  strict?: boolean
  required?: string[]
  vectorPromotion?: VectorIndexConfig
  patternValueLimit?: number
  partitionConfig?: ClusterPartitionLimits
  embedding?: RestoredEmbedding
}

export interface ClusterPartitionLimits {
  maxDocsPerPartition?: number
  watermark?: number
}

type SettingsSource = Omit<IndexConfig, 'schema' | 'language'>

function partitionLimitsOf(partitions: PartitionConfig | undefined): ClusterPartitionLimits | undefined {
  if (partitions === undefined) {
    return undefined
  }
  const { maxDocsPerPartition, watermark } = partitions
  if (maxDocsPerPartition === undefined && watermark === undefined) {
    return undefined
  }
  return {
    ...(maxDocsPerPartition !== undefined ? { maxDocsPerPartition } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
  }
}

function codeInSettings(option: string, registration: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `A node cannot serialise code into the cluster's index metadata, so register the index ${option} with ${registration} and pass its name`,
    { option },
  )
}

function settingsFieldsOf(source: SettingsSource): Omit<IndexSettings, 'language'> {
  const { tokenizer, stopWords, bm25, embedding } = source
  const partitionConfig = partitionLimitsOf(source.partitions)
  if (tokenizer !== undefined && typeof tokenizer !== 'string') {
    throw codeInSettings('tokenizer', 'registerTokenizer')
  }
  if (typeof stopWords === 'function') {
    throw codeInSettings('stop words', 'registerStopWords')
  }
  if (embedding?.adapter !== undefined && typeof embedding.adapter !== 'string') {
    throw codeInSettings('embedding adapter', 'registerEmbeddingAdapter')
  }
  return {
    ...(tokenizer !== undefined ? { tokenizer } : {}),
    ...(typeof stopWords === 'string' ? { stopWords } : {}),
    ...(stopWords instanceof Set ? { stopWordList: [...stopWords].sort(compareCodePoints) } : {}),
    ...(bm25 !== undefined
      ? {
          bm25: {
            ...(bm25.k1 !== undefined ? { k1: bm25.k1 } : {}),
            ...(bm25.b !== undefined ? { b: bm25.b } : {}),
          },
        }
      : {}),
    ...(source.surfaceForms !== undefined ? { surfaceForms: source.surfaceForms } : {}),
    ...(source.defaultScoring !== undefined ? { defaultScoring: source.defaultScoring } : {}),
    ...(source.trackPositions !== undefined ? { trackPositions: source.trackPositions } : {}),
    ...(source.strict !== undefined ? { strict: source.strict } : {}),
    ...(source.required !== undefined ? { required: source.required } : {}),
    ...(source.vectorPromotion !== undefined ? { vectorPromotion: source.vectorPromotion } : {}),
    ...(source.patternValueLimit !== undefined ? { patternValueLimit: source.patternValueLimit } : {}),
    ...(partitionConfig !== undefined ? { partitionConfig } : {}),
    ...(embedding !== undefined
      ? {
          embedding: {
            fields: embedding.fields,
            ...(typeof embedding.adapter === 'string' ? { adapter: embedding.adapter } : {}),
          },
        }
      : {}),
  }
}

export function indexSettingsOf(config: IndexConfig): IndexSettings {
  return {
    language: getLanguage(config.language ?? 'english').name,
    ...settingsFieldsOf(config),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function settingsRejection(indexName: string): ConfigFieldRejection {
  return (message: string): never => {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid settings: ${message}`,
      { indexName },
    )
  }
}

export function decodeIndexSettings(raw: unknown, indexName: string): IndexSettings | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }
  const reject = settingsRejection(indexName)
  if (!isRecord(raw)) {
    return reject('settings must be an object')
  }
  if (typeof raw.language !== 'string' || raw.language.length === 0) {
    return reject('language must be a name')
  }
  const embedding = restoredEmbedding(raw.embedding, reject)
  const partitions = restoredPartitionConfig(raw.partitionConfig, reject)
  return {
    language: raw.language,
    ...settingsFieldsOf({
      ...readSharedConfigFields(raw, reject),
      ...(partitions !== undefined ? { partitions } : {}),
      ...(embedding !== undefined ? { embedding } : {}),
    }),
  }
}

export function indexConfigFromSettings(
  schema: SchemaDefinition,
  settings: IndexSettings | undefined,
  indexName: string,
): IndexConfig {
  if (settings === undefined) {
    return { schema }
  }
  const { language, embedding, partitionConfig, ...fields } = settings
  return {
    schema,
    language,
    ...readSharedConfigFields(fields, settingsRejection(indexName)),
    ...(partitionConfig !== undefined ? { partitions: { ...partitionConfig } } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
  }
}
