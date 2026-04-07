import type { EmbeddingAdapter } from './adapters'

export type AnyDocument = Record<string, unknown> & { id?: string }

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'geopoint'
  | `vector[${number}]`
  | 'string[]'
  | 'number[]'
  | 'boolean[]'
  | 'enum[]'

export type SchemaDefinition = {
  [field: string]: FieldType | SchemaDefinition
}

export type VectorQuantizationMode = 'sq8' | 'none'

export interface VectorIndexConfig {
  threshold?: number
  filterThreshold?: number
  hnswConfig?: { m?: number; efConstruction?: number; metric?: 'cosine' | 'dotProduct' | 'euclidean' }
  quantization?: VectorQuantizationMode
}

/** @deprecated Use VectorIndexConfig instead */
export type VectorPromotionConfig = VectorIndexConfig

export interface EmbeddingFieldConfig {
  adapter?: EmbeddingAdapter
  fields: Record<string, string | string[]>
}

export interface IndexConfig {
  schema: SchemaDefinition
  language?: string
  partitions?: PartitionConfig
  defaultScoring?: ScoringMode
  bm25?: BM25Params
  stopWords?: Set<string> | ((defaults: Set<string>) => Set<string>)
  tokenizer?: CustomTokenizer
  trackPositions?: boolean
  vectorPromotion?: VectorIndexConfig
  strict?: boolean
  embedding?: EmbeddingFieldConfig
  required?: string[]
}

export interface BM25Params {
  k1?: number
  b?: number
}

export interface CustomTokenizer {
  tokenize(text: string): Array<{ token: string; position: number }>
}

export interface PartitionConfig {
  maxDocsPerPartition?: number
  maxPartitions?: number
}

export type ScoringMode = 'local' | 'dfs' | 'broadcast'

export interface InsertOptions {
  skipClone?: boolean
}
