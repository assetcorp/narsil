import { decode, encode } from '@msgpack/msgpack'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndexConfig } from '../../types/schema'

interface RawMetadataPayload {
  index_name: string
  schema: Record<string, string>
  language: string
  partition_count: number
  bm25_params: { k1: number; b: number }
  created_at: number
  engine_version: string
  vector_fields?: Record<string, { dimension: number; metric: string; quantization: string }>
  embedding?: { adapter?: string; fields: Record<string, string | string[]> }
  surface_forms_enabled?: boolean
  analysis_revision?: string
  tokenizer?: string
  stop_words?: string
  stop_word_list?: string[]
  partition_limits?: { max_docs_per_partition?: unknown; max_partitions?: unknown; watermark?: unknown }
  default_scoring?: unknown
  track_positions?: unknown
  strict?: unknown
  required?: unknown
  vector_promotion?: {
    threshold?: unknown
    filter_threshold?: unknown
    hnsw_config?: { m?: unknown; ef_construction?: unknown; metric?: unknown }
    quantization?: unknown
  }
  index_uuid?: unknown
  held_partitions?: unknown
}

function metadataToWire(meta: IndexMetadata): RawMetadataPayload {
  const wire: RawMetadataPayload = {
    index_name: meta.indexName,
    schema: meta.schema,
    language: meta.language,
    partition_count: meta.partitionCount,
    bm25_params: meta.bm25Params,
    created_at: meta.createdAt,
    engine_version: meta.engineVersion,
  }
  if (meta.vectorFields) {
    wire.vector_fields = meta.vectorFields
  }
  if (meta.embedding) {
    wire.embedding =
      meta.embedding.adapter !== undefined
        ? { adapter: meta.embedding.adapter, fields: meta.embedding.fields }
        : { fields: meta.embedding.fields }
  }
  if (meta.surfaceForms !== undefined) {
    wire.surface_forms_enabled = meta.surfaceForms
  }
  if (meta.analysisRevision !== undefined) {
    wire.analysis_revision = meta.analysisRevision
  }
  if (meta.tokenizer !== undefined) {
    wire.tokenizer = meta.tokenizer
  }
  if (meta.stopWords !== undefined) {
    wire.stop_words = meta.stopWords
  }
  if (meta.stopWordList !== undefined) {
    wire.stop_word_list = meta.stopWordList
  }
  if (meta.partitionLimits !== undefined) {
    wire.partition_limits = {
      ...(meta.partitionLimits.maxDocsPerPartition !== undefined
        ? { max_docs_per_partition: meta.partitionLimits.maxDocsPerPartition }
        : {}),
      ...(meta.partitionLimits.maxPartitions !== undefined
        ? { max_partitions: meta.partitionLimits.maxPartitions }
        : {}),
      ...(meta.partitionLimits.watermark !== undefined ? { watermark: meta.partitionLimits.watermark } : {}),
    }
  }
  if (meta.defaultScoring !== undefined) {
    wire.default_scoring = meta.defaultScoring
  }
  if (meta.trackPositions !== undefined) {
    wire.track_positions = meta.trackPositions
  }
  if (meta.strict !== undefined) {
    wire.strict = meta.strict
  }
  if (meta.required !== undefined) {
    wire.required = meta.required
  }
  if (meta.vectorPromotion !== undefined) {
    const promotion = meta.vectorPromotion
    wire.vector_promotion = {
      ...(promotion.threshold !== undefined ? { threshold: promotion.threshold } : {}),
      ...(promotion.filterThreshold !== undefined ? { filter_threshold: promotion.filterThreshold } : {}),
      ...(promotion.hnswConfig !== undefined
        ? {
            hnsw_config: {
              ...(promotion.hnswConfig.m !== undefined ? { m: promotion.hnswConfig.m } : {}),
              ...(promotion.hnswConfig.efConstruction !== undefined
                ? { ef_construction: promotion.hnswConfig.efConstruction }
                : {}),
              ...(promotion.hnswConfig.metric !== undefined ? { metric: promotion.hnswConfig.metric } : {}),
            },
          }
        : {}),
      ...(promotion.quantization !== undefined ? { quantization: promotion.quantization } : {}),
    }
  }
  if (meta.indexUuid !== undefined) {
    wire.index_uuid = meta.indexUuid
  }
  if (meta.heldPartitions !== undefined) {
    wire.held_partitions = meta.heldPartitions
  }
  return wire
}

function wireToMetadata(raw: RawMetadataPayload): IndexMetadata {
  const meta: IndexMetadata = {
    indexName: raw.index_name,
    schema: raw.schema ?? {},
    language: raw.language ?? 'english',
    partitionCount: raw.partition_count ?? 1,
    bm25Params: raw.bm25_params ?? { k1: 1.2, b: 0.75 },
    createdAt: raw.created_at ?? 0,
    engineVersion: raw.engine_version ?? '0.0.0',
  }
  if (raw.vector_fields) {
    meta.vectorFields = raw.vector_fields
  }
  if (raw.embedding && typeof raw.embedding === 'object' && typeof raw.embedding.fields === 'object') {
    meta.embedding =
      typeof raw.embedding.adapter === 'string'
        ? { adapter: raw.embedding.adapter, fields: raw.embedding.fields }
        : { fields: raw.embedding.fields }
  }
  if (typeof raw.surface_forms_enabled === 'boolean') {
    meta.surfaceForms = raw.surface_forms_enabled
  }
  if (typeof raw.analysis_revision === 'string') {
    meta.analysisRevision = raw.analysis_revision
  }
  if (typeof raw.tokenizer === 'string') {
    meta.tokenizer = raw.tokenizer
  }
  if (typeof raw.stop_words === 'string') {
    meta.stopWords = raw.stop_words
  }
  if (Array.isArray(raw.stop_word_list) && raw.stop_word_list.every(word => typeof word === 'string')) {
    meta.stopWordList = raw.stop_word_list
  }
  if (raw.partition_limits && typeof raw.partition_limits === 'object') {
    const limits = {
      ...(isPositiveInteger(raw.partition_limits.max_docs_per_partition)
        ? { maxDocsPerPartition: raw.partition_limits.max_docs_per_partition }
        : {}),
      ...(isPositiveInteger(raw.partition_limits.max_partitions)
        ? { maxPartitions: raw.partition_limits.max_partitions }
        : {}),
      ...(isWatermarkFraction(raw.partition_limits.watermark) ? { watermark: raw.partition_limits.watermark } : {}),
    }
    if (Object.keys(limits).length > 0) {
      meta.partitionLimits = limits
    }
  }
  if (raw.default_scoring === 'local' || raw.default_scoring === 'dfs' || raw.default_scoring === 'broadcast') {
    meta.defaultScoring = raw.default_scoring
  }
  if (typeof raw.track_positions === 'boolean') {
    meta.trackPositions = raw.track_positions
  }
  if (typeof raw.strict === 'boolean') {
    meta.strict = raw.strict
  }
  if (Array.isArray(raw.required) && raw.required.every(field => typeof field === 'string')) {
    meta.required = raw.required
  }
  if (raw.vector_promotion && typeof raw.vector_promotion === 'object') {
    const promotion = raw.vector_promotion
    const hnsw = promotion.hnsw_config && typeof promotion.hnsw_config === 'object' ? promotion.hnsw_config : undefined
    const metric = hnsw?.metric
    const restored: VectorIndexConfig = {}
    const hnswConfig: NonNullable<VectorIndexConfig['hnswConfig']> = {}
    if (isPositiveInteger(hnsw?.m)) {
      hnswConfig.m = hnsw?.m
    }
    if (isPositiveInteger(hnsw?.ef_construction)) {
      hnswConfig.efConstruction = hnsw?.ef_construction
    }
    if (metric === 'cosine' || metric === 'dotProduct' || metric === 'euclidean') {
      hnswConfig.metric = metric
    }
    if (isPositiveInteger(promotion.threshold)) {
      restored.threshold = promotion.threshold
    }
    if (isPositiveInteger(promotion.filter_threshold)) {
      restored.filterThreshold = promotion.filter_threshold
    }
    if (Object.keys(hnswConfig).length > 0) {
      restored.hnswConfig = hnswConfig
    }
    if (promotion.quantization === 'sq8' || promotion.quantization === 'none') {
      restored.quantization = promotion.quantization
    }
    if (Object.keys(restored).length > 0) {
      meta.vectorPromotion = restored
    }
  }
  if (typeof raw.index_uuid === 'string' && raw.index_uuid.length > 0) {
    meta.indexUuid = raw.index_uuid
  }
  if (Array.isArray(raw.held_partitions) && raw.held_partitions.every(isNonNegativeInteger)) {
    meta.heldPartitions = raw.held_partitions
  }
  return meta
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isWatermarkFraction(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 1
}

export function serializeMetadata(meta: IndexMetadata): Uint8Array {
  const wire = metadataToWire(meta)
  return encode(wire)
}

export function deserializeMetadata(data: Uint8Array): IndexMetadata {
  const raw = decode(data) as RawMetadataPayload
  return wireToMetadata(raw)
}
