import { ErrorCodes, NarsilError } from '../../errors'
import type { BM25Params, IndexConfig, PartitionConfig, ScoringMode, VectorIndexConfig } from '../../types/schema'
import type { VectorIndexPayload } from '../../vector/vector-index'

export interface SnapshotEnvelope {
  version?: number
  schema?: Record<string, string>
  language?: string
  analysisRevision?: unknown
  tokenizer?: unknown
  stopWords?: unknown
  stopWordList?: unknown
  bm25?: unknown
  surfaceForms?: unknown
  partitionConfig?: unknown
  defaultScoring?: unknown
  trackPositions?: unknown
  strict?: unknown
  required?: unknown
  vectorPromotion?: unknown
  embedding?: unknown
  partitions?: Uint8Array[]
  vectorIndexes?: Record<string, VectorIndexPayload>
}

export interface RestoredEmbedding {
  fields: Record<string, string | string[]>
  adapter?: string
}

export type RestoredConfigFields = Omit<IndexConfig, 'schema' | 'language' | 'embedding'>

function invalid(message: string): never {
  throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Invalid snapshot: ${message}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function restoredBm25(raw: unknown): BM25Params | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    invalid('bm25 must be an object')
  }
  const { k1, b } = raw as { k1?: unknown; b?: unknown }
  if (k1 !== undefined && (typeof k1 !== 'number' || !Number.isFinite(k1))) {
    invalid('bm25 k1 must be a finite number')
  }
  if (b !== undefined && (typeof b !== 'number' || !Number.isFinite(b))) {
    invalid('bm25 b must be a finite number')
  }
  return {
    ...(k1 !== undefined ? { k1: k1 as number } : {}),
    ...(b !== undefined ? { b: b as number } : {}),
  }
}

function restoredStopWords(name: unknown, list: unknown): IndexConfig['stopWords'] {
  if (name !== undefined && typeof name !== 'string') {
    invalid('stopWords must be a name')
  }
  if (list !== undefined && (!Array.isArray(list) || !list.every(word => typeof word === 'string'))) {
    invalid('stopWordList must be a list of words')
  }
  if (typeof name === 'string' && Array.isArray(list)) {
    invalid('stopWords and stopWordList cannot both be present')
  }
  if (typeof name === 'string') {
    return name
  }
  if (Array.isArray(list)) {
    return new Set(list as string[])
  }
  return undefined
}

function restoredPartitionConfig(raw: unknown): PartitionConfig | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    invalid('partitionConfig must be an object')
  }
  const { maxDocsPerPartition, maxPartitions, watermark } = raw as {
    maxDocsPerPartition?: unknown
    maxPartitions?: unknown
    watermark?: unknown
  }
  if (
    maxDocsPerPartition !== undefined &&
    (typeof maxDocsPerPartition !== 'number' || !Number.isInteger(maxDocsPerPartition) || maxDocsPerPartition < 1)
  ) {
    invalid('partitionConfig maxDocsPerPartition must be a positive integer')
  }
  if (
    maxPartitions !== undefined &&
    (typeof maxPartitions !== 'number' || !Number.isInteger(maxPartitions) || maxPartitions < 1)
  ) {
    invalid('partitionConfig maxPartitions must be a positive integer')
  }
  if (watermark !== undefined && (typeof watermark !== 'number' || !(watermark > 0) || watermark > 1)) {
    invalid('partitionConfig watermark must be above 0 and at most 1')
  }
  return {
    ...(typeof maxDocsPerPartition === 'number' ? { maxDocsPerPartition } : {}),
    ...(typeof maxPartitions === 'number' ? { maxPartitions } : {}),
    ...(typeof watermark === 'number' ? { watermark } : {}),
  }
}

function restoredScoring(raw: unknown): ScoringMode | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw !== 'local' && raw !== 'dfs' && raw !== 'broadcast') {
    invalid("defaultScoring must be 'local', 'dfs', or 'broadcast'")
  }
  return raw
}

function restoredBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'boolean') {
    invalid(`${field} must be a boolean`)
  }
  return raw
}

function restoredRequired(raw: unknown): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw) || !raw.every(field => typeof field === 'string')) {
    invalid('required must be a list of field paths')
  }
  return raw
}

function restoredVectorPromotion(raw: unknown): VectorIndexConfig | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw) || (raw.hnswConfig !== undefined && !isPlainObject(raw.hnswConfig))) {
    invalid('vectorPromotion must be an object')
  }
  return raw as VectorIndexConfig
}

export function restoredEmbedding(raw: unknown): RestoredEmbedding | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    invalid('embedding must be an object')
  }
  const { fields, adapter } = raw as { fields?: unknown; adapter?: unknown }
  if (adapter !== undefined && typeof adapter !== 'string') {
    invalid('embedding adapter must be a name')
  }
  if (!isPlainObject(fields)) {
    invalid('embedding fields must be an object')
  }
  for (const value of Object.values(fields)) {
    const isPath = typeof value === 'string'
    const isPathList = Array.isArray(value) && value.every(path => typeof path === 'string')
    if (!isPath && !isPathList) {
      invalid('embedding fields must map vector fields to source paths')
    }
  }
  return {
    fields: fields as Record<string, string | string[]>,
    ...(adapter !== undefined ? { adapter: adapter as string } : {}),
  }
}

export function restoredConfigFields(envelope: SnapshotEnvelope): RestoredConfigFields {
  if (envelope.tokenizer !== undefined && typeof envelope.tokenizer !== 'string') {
    invalid('tokenizer must be a name')
  }
  const stopWords = restoredStopWords(envelope.stopWords, envelope.stopWordList)
  const bm25 = restoredBm25(envelope.bm25)
  const surfaceForms = restoredBoolean(envelope.surfaceForms, 'surfaceForms')
  const partitions = restoredPartitionConfig(envelope.partitionConfig)
  const defaultScoring = restoredScoring(envelope.defaultScoring)
  const trackPositions = restoredBoolean(envelope.trackPositions, 'trackPositions')
  const strict = restoredBoolean(envelope.strict, 'strict')
  const required = restoredRequired(envelope.required)
  const vectorPromotion = restoredVectorPromotion(envelope.vectorPromotion)

  return {
    ...(typeof envelope.tokenizer === 'string' ? { tokenizer: envelope.tokenizer } : {}),
    ...(stopWords !== undefined ? { stopWords } : {}),
    ...(bm25 !== undefined ? { bm25 } : {}),
    ...(surfaceForms !== undefined ? { surfaceForms } : {}),
    ...(partitions !== undefined ? { partitions } : {}),
    ...(defaultScoring !== undefined ? { defaultScoring } : {}),
    ...(trackPositions !== undefined ? { trackPositions } : {}),
    ...(strict !== undefined ? { strict } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(vectorPromotion !== undefined ? { vectorPromotion } : {}),
  }
}
