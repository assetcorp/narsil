import { ErrorCodes, NarsilError } from '../../errors'
import type {
  BM25FieldParams,
  BM25Params,
  IndexConfig,
  PartitionConfig,
  ScoringMode,
  VectorIndexConfig,
} from '../../types/schema'

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
  patternValueLimit?: unknown
  synonyms?: unknown
  embedding?: unknown
  partitions?: Uint8Array[]
  vectorIndexes?: Record<string, unknown>
}

export type ConfigFieldSource = Pick<
  SnapshotEnvelope,
  | 'tokenizer'
  | 'stopWords'
  | 'stopWordList'
  | 'bm25'
  | 'surfaceForms'
  | 'defaultScoring'
  | 'trackPositions'
  | 'strict'
  | 'required'
  | 'vectorPromotion'
  | 'patternValueLimit'
>

export type ConfigFieldRejection = (message: string) => never

export interface RestoredEmbedding {
  fields: Record<string, string | string[]>
  adapter?: string
}

export type RestoredConfigFields = Omit<IndexConfig, 'schema' | 'language' | 'embedding'>

export type SharedConfigFields = Omit<RestoredConfigFields, 'partitions'>

export function rejectSnapshot(message: string): never {
  throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Invalid snapshot: ${message}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function restoredBm25(raw: unknown, reject: ConfigFieldRejection): BM25Params | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    reject('bm25 must be an object')
  }
  const fields = restoredBm25Fields(raw.fields, reject)
  return {
    ...restoredBm25Pair(raw, 'bm25', reject),
    ...(fields !== undefined ? { fields } : {}),
  }
}

function restoredBm25Pair(raw: Record<string, unknown>, label: string, reject: ConfigFieldRejection): BM25FieldParams {
  const { k1, b } = raw
  if (k1 !== undefined && (typeof k1 !== 'number' || !Number.isFinite(k1))) {
    reject(`${label} k1 must be a finite number`)
  }
  if (b !== undefined && (typeof b !== 'number' || !Number.isFinite(b))) {
    reject(`${label} b must be a finite number`)
  }
  return {
    ...(k1 !== undefined ? { k1: k1 as number } : {}),
    ...(b !== undefined ? { b: b as number } : {}),
  }
}

function restoredBm25Fields(raw: unknown, reject: ConfigFieldRejection): Record<string, BM25FieldParams> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) reject('bm25 fields must be an object')
  const source = raw as Record<string, unknown>
  const fields: Record<string, BM25FieldParams> = Object.create(null)
  for (const name of Object.keys(source)) {
    const pair = source[name]
    if (!isPlainObject(pair)) reject('bm25 fields must map each field to an object')
    fields[name] = restoredBm25Pair(pair as Record<string, unknown>, 'bm25 field', reject)
  }
  return fields
}

function restoredStopWords(name: unknown, list: unknown, reject: ConfigFieldRejection): IndexConfig['stopWords'] {
  if (name !== undefined && typeof name !== 'string') {
    reject('stopWords must be a name')
  }
  if (list !== undefined && (!Array.isArray(list) || !list.every(word => typeof word === 'string'))) {
    reject('stopWordList must be a list of words')
  }
  if (typeof name === 'string' && Array.isArray(list)) {
    reject('stopWords and stopWordList cannot both be present')
  }
  if (typeof name === 'string') {
    return name
  }
  if (Array.isArray(list)) {
    return new Set(list as string[])
  }
  return undefined
}

export function restoredPartitionConfig(
  raw: unknown,
  reject: ConfigFieldRejection = rejectSnapshot,
): PartitionConfig | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    reject('partitionConfig must be an object')
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
    reject('partitionConfig maxDocsPerPartition must be a positive integer')
  }
  if (
    maxPartitions !== undefined &&
    (typeof maxPartitions !== 'number' || !Number.isInteger(maxPartitions) || maxPartitions < 1)
  ) {
    reject('partitionConfig maxPartitions must be a positive integer')
  }
  if (watermark !== undefined && (typeof watermark !== 'number' || !(watermark > 0) || watermark > 1)) {
    reject('partitionConfig watermark must be above 0 and at most 1')
  }
  return {
    ...(typeof maxDocsPerPartition === 'number' ? { maxDocsPerPartition } : {}),
    ...(typeof maxPartitions === 'number' ? { maxPartitions } : {}),
    ...(typeof watermark === 'number' ? { watermark } : {}),
  }
}

function restoredScoring(raw: unknown, reject: ConfigFieldRejection): ScoringMode | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw !== 'local' && raw !== 'dfs' && raw !== 'broadcast') {
    reject("defaultScoring must be 'local', 'dfs', or 'broadcast'")
  }
  return raw
}

function restoredBoolean(raw: unknown, field: string, reject: ConfigFieldRejection): boolean | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'boolean') {
    reject(`${field} must be a boolean`)
  }
  return raw
}

function restoredRequired(raw: unknown, reject: ConfigFieldRejection): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw) || !raw.every(field => typeof field === 'string')) {
    reject('required must be a list of field paths')
  }
  return raw
}

function restoredVectorPromotion(raw: unknown, reject: ConfigFieldRejection): VectorIndexConfig | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw) || (raw.hnswConfig !== undefined && !isPlainObject(raw.hnswConfig))) {
    reject('vectorPromotion must be an object')
  }
  return raw as VectorIndexConfig
}

export function restoredEmbedding(
  raw: unknown,
  reject: ConfigFieldRejection = rejectSnapshot,
): RestoredEmbedding | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isPlainObject(raw)) {
    reject('embedding must be an object')
  }
  const { fields, adapter } = raw as { fields?: unknown; adapter?: unknown }
  if (adapter !== undefined && typeof adapter !== 'string') {
    reject('embedding adapter must be a name')
  }
  if (!isPlainObject(fields)) {
    reject('embedding fields must be an object')
  }
  for (const value of Object.values(fields)) {
    const isPath = typeof value === 'string'
    const isPathList = Array.isArray(value) && value.every(path => typeof path === 'string')
    if (!isPath && !isPathList) {
      reject('embedding fields must map vector fields to source paths')
    }
  }
  return {
    fields: fields as Record<string, string | string[]>,
    ...(adapter !== undefined ? { adapter: adapter as string } : {}),
  }
}

export function readSharedConfigFields(source: ConfigFieldSource, reject: ConfigFieldRejection): SharedConfigFields {
  if (source.tokenizer !== undefined && typeof source.tokenizer !== 'string') {
    reject('tokenizer must be a name')
  }
  const stopWords = restoredStopWords(source.stopWords, source.stopWordList, reject)
  const bm25 = restoredBm25(source.bm25, reject)
  const surfaceForms = restoredBoolean(source.surfaceForms, 'surfaceForms', reject)
  const defaultScoring = restoredScoring(source.defaultScoring, reject)
  const trackPositions = restoredBoolean(source.trackPositions, 'trackPositions', reject)
  const strict = restoredBoolean(source.strict, 'strict', reject)
  const required = restoredRequired(source.required, reject)
  const vectorPromotion = restoredVectorPromotion(source.vectorPromotion, reject)
  if (source.patternValueLimit !== undefined && typeof source.patternValueLimit !== 'number') {
    reject('patternValueLimit must be a number')
  }

  return {
    ...(typeof source.tokenizer === 'string' ? { tokenizer: source.tokenizer } : {}),
    ...(stopWords !== undefined ? { stopWords } : {}),
    ...(bm25 !== undefined ? { bm25 } : {}),
    ...(surfaceForms !== undefined ? { surfaceForms } : {}),
    ...(defaultScoring !== undefined ? { defaultScoring } : {}),
    ...(trackPositions !== undefined ? { trackPositions } : {}),
    ...(strict !== undefined ? { strict } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(vectorPromotion !== undefined ? { vectorPromotion } : {}),
    ...(typeof source.patternValueLimit === 'number' ? { patternValueLimit: source.patternValueLimit } : {}),
  }
}

export function restoredConfigFields(
  envelope: SnapshotEnvelope,
  reject: ConfigFieldRejection = rejectSnapshot,
): RestoredConfigFields {
  const shared = readSharedConfigFields(envelope, reject)
  const partitions = restoredPartitionConfig(envelope.partitionConfig, reject)
  return {
    ...shared,
    ...(partitions !== undefined ? { partitions } : {}),
  }
}
