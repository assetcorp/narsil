import { DEFAULT_BM25_B, DEFAULT_BM25_K1 } from '../core/constants'
import { compareCodePoints } from '../core/ordering'
import { VERSION } from '../index'
import { flattenSchema } from '../schema/validator'
import type { IndexEmbeddingMetadata, IndexMetadata, PendingAnalysisMetadata } from '../types/internal'
import type { BM25FieldParams, PartitionConfig, ScoringMode, VectorIndexConfig } from '../types/schema'
import type { SynonymRule } from '../types/synonyms'
import type { IndexRegistryEntry } from './core'
import { rulesOfStoredSynonyms } from './synonym-sets'

export interface MetadataConfig {
  indexUuid?: string
  heldPartitions?: number[]
  documentCount: number
  partitionCount: number
  schema: Record<string, string>
  language: string
  k1: number
  b: number
  bm25Fields?: Record<string, BM25FieldParams>
  embedding?: IndexEmbeddingMetadata
  surfaceForms?: boolean
  analysisRevision?: string
  arrayPositionGap?: number
  tokenizer?: string
  stopWords?: string
  stopWordList?: string[]
  analysisGeneration?: number
  pendingAnalysis?: PendingAnalysisMetadata
  partitionLimits?: PartitionConfig
  defaultScoring?: ScoringMode
  trackPositions?: boolean
  textStorage?: 'memory' | 'disk'
  strict?: boolean
  required?: string[]
  vectorPromotion?: VectorIndexConfig
  patternValueLimit?: number
  synonyms?: SynonymRule[]
}

export function metadataFromConfig(
  indexName: string,
  config: MetadataConfig,
  partitionCount: number | undefined,
  documentCount?: number,
): IndexMetadata {
  const metadata: IndexMetadata = {
    indexName,
    schema: config.schema,
    language: config.language,
    partitionCount: partitionCount ?? config.partitionCount,
    bm25Params: {
      k1: config.k1,
      b: config.b,
      ...(config.bm25Fields !== undefined ? { fields: config.bm25Fields } : {}),
    },
    createdAt: Date.now(),
    engineVersion: VERSION,
  }
  metadata.documentCount = documentCount ?? config.documentCount
  if (config.embedding) {
    metadata.embedding = config.embedding
  }
  if (config.surfaceForms !== undefined) {
    metadata.surfaceForms = config.surfaceForms
  }
  if (config.analysisRevision !== undefined) {
    metadata.analysisRevision = config.analysisRevision
  }
  if (config.arrayPositionGap !== undefined) {
    metadata.arrayPositionGap = config.arrayPositionGap
  }
  if (config.tokenizer !== undefined) {
    metadata.tokenizer = config.tokenizer
  }
  if (config.stopWords !== undefined) {
    metadata.stopWords = config.stopWords
  }
  if (config.stopWordList !== undefined) {
    metadata.stopWordList = config.stopWordList
  }
  if (config.analysisGeneration !== undefined) {
    metadata.analysisGeneration = config.analysisGeneration
  }
  if (config.pendingAnalysis !== undefined) {
    metadata.pendingAnalysis = config.pendingAnalysis
  }
  if (config.partitionLimits !== undefined) {
    metadata.partitionLimits = config.partitionLimits
  }
  if (config.defaultScoring !== undefined) {
    metadata.defaultScoring = config.defaultScoring
  }
  if (config.trackPositions !== undefined) {
    metadata.trackPositions = config.trackPositions
  }
  if (config.textStorage !== undefined) {
    metadata.textStorage = config.textStorage
  }
  if (config.strict !== undefined) {
    metadata.strict = config.strict
  }
  if (config.required !== undefined) {
    metadata.required = config.required
  }
  if (config.vectorPromotion !== undefined) {
    metadata.vectorPromotion = config.vectorPromotion
  }
  if (config.patternValueLimit !== undefined) {
    metadata.patternValueLimit = config.patternValueLimit
  }
  if (config.indexUuid !== undefined) {
    metadata.indexUuid = config.indexUuid
  }
  if (config.synonyms !== undefined) {
    metadata.synonyms = config.synonyms
  }
  if (config.heldPartitions !== undefined) {
    metadata.heldPartitions = config.heldPartitions
  }
  return metadata
}

export function metadataConfigOf(entry: IndexRegistryEntry): MetadataConfig {
  const embedding = entry.config.embedding
    ? {
        fields: entry.config.embedding.fields,
        ...(entry.embeddingAdapterName !== null ? { adapter: entry.embeddingAdapterName } : {}),
      }
    : undefined
  return {
    ...(entry.indexUuid !== null ? { indexUuid: entry.indexUuid } : {}),
    ...(entry.heldPartitions !== null ? { heldPartitions: entry.heldPartitions } : {}),
    documentCount: entry.documentCount,
    partitionCount: entry.partitionCount,
    schema: flattenSchema(entry.config.schema) as Record<string, string>,
    language: entry.language.name,
    k1: entry.config.bm25?.k1 ?? DEFAULT_BM25_K1,
    b: entry.config.bm25?.b ?? DEFAULT_BM25_B,
    ...(entry.config.bm25?.fields !== undefined ? { bm25Fields: entry.config.bm25.fields } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    surfaceForms: entry.config.surfaceForms !== false,
    ...(entry.analysisRevision !== null ? { analysisRevision: entry.analysisRevision } : {}),
    ...(entry.arrayPositionGap !== null ? { arrayPositionGap: entry.arrayPositionGap } : {}),
    ...(typeof entry.config.tokenizer === 'string' ? { tokenizer: entry.config.tokenizer } : {}),
    ...(typeof entry.config.stopWords === 'string' ? { stopWords: entry.config.stopWords } : {}),
    ...(entry.config.stopWords instanceof Set
      ? { stopWordList: [...entry.config.stopWords].sort(compareCodePoints) }
      : {}),
    ...(entry.analysisGeneration > 0 ? { analysisGeneration: entry.analysisGeneration } : {}),
    ...(entry.pendingAnalysis !== null ? { pendingAnalysis: entry.pendingAnalysis } : {}),
    ...(entry.config.partitions !== undefined ? { partitionLimits: entry.config.partitions } : {}),
    ...(entry.config.defaultScoring !== undefined ? { defaultScoring: entry.config.defaultScoring } : {}),
    ...(entry.config.trackPositions !== undefined ? { trackPositions: entry.config.trackPositions } : {}),
    ...(entry.config.textStorage !== undefined ? { textStorage: entry.config.textStorage } : {}),
    ...(entry.config.strict !== undefined ? { strict: entry.config.strict } : {}),
    ...(entry.config.required !== undefined ? { required: entry.config.required } : {}),
    ...(entry.config.vectorPromotion !== undefined ? { vectorPromotion: entry.config.vectorPromotion } : {}),
    ...(entry.config.patternValueLimit !== undefined ? { patternValueLimit: entry.config.patternValueLimit } : {}),
    ...(entry.synonyms !== null ? { synonyms: rulesOfStoredSynonyms(entry.synonyms) } : {}),
  }
}

export function durableMetadataConfigOf(entry: IndexRegistryEntry): MetadataConfig {
  const terms = metadataConfigOf(entry)
  const durable = entry.durableAnalysis
  if (durable === null) return terms
  const {
    language,
    tokenizer,
    stopWords,
    stopWordList,
    analysisRevision: _analysisRevision,
    arrayPositionGap: _arrayPositionGap,
    analysisGeneration: _analysisGeneration,
    ...rest
  } = terms
  return {
    ...rest,
    language: durable.language,
    ...(durable.tokenizer !== undefined ? { tokenizer: durable.tokenizer } : {}),
    ...(durable.stopWords !== undefined ? { stopWords: durable.stopWords } : {}),
    ...(durable.stopWordList !== undefined ? { stopWordList: durable.stopWordList } : {}),
    ...(durable.analysisRevision !== null ? { analysisRevision: durable.analysisRevision } : {}),
    ...(durable.arrayPositionGap !== null ? { arrayPositionGap: durable.arrayPositionGap } : {}),
    ...(durable.generation > 0 ? { analysisGeneration: durable.generation } : {}),
    pendingAnalysis: {
      generation: entry.analysisGeneration,
      language,
      ...(tokenizer !== undefined ? { tokenizer } : {}),
      ...(stopWords !== undefined ? { stopWords } : {}),
      ...(stopWordList !== undefined ? { stopWordList } : {}),
    },
  }
}

export function indexMetadataOf(indexName: string, entry: IndexRegistryEntry, partitionCount: number): IndexMetadata {
  return metadataFromConfig(indexName, metadataConfigOf(entry), partitionCount)
}
