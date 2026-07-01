import type { BeirDatasetName } from '../data/beir'
import type {
  MutationResult,
  RelevanceQualityResult,
  ScaleResult,
  SerializationResult,
  VectorRelevanceResult,
} from '../types'

export type EngineId = 'narsil' | 'orama' | 'minisearch'

export type AdapterKind = 'text-only' | 'full-schema' | 'serializable' | 'vector'

export type DataSource = 'fiqa' | 'synthetic'

export interface TextJobSpec {
  kind: 'text'
  engine: EngineId
  adapter: 'text-only' | 'full-schema'
  scale: number
  dataSource: DataSource
  seed: number
  searchQueryCount: number
  measureWarmupAndIterations?: { warmup: number; iterations: number }
}

export interface VectorJobSpec {
  kind: 'vector'
  engine: EngineId
  dataset: BeirDatasetName
}

export interface SerializationJobSpec {
  kind: 'serialization'
  engine: EngineId
  docCount: number
  dataSource: DataSource
  seed: number
}

export interface MutationJobSpec {
  kind: 'mutation'
  engine: EngineId
  docCount: number
  dataSource: DataSource
  seed: number
  searchQueryCount: number
}

export interface RelevanceJobSpec {
  kind: 'relevance'
  engine: EngineId
  dataset: BeirDatasetName
}

export type JobSpec = TextJobSpec | VectorJobSpec | SerializationJobSpec | MutationJobSpec | RelevanceJobSpec

export interface JobSuccessText {
  kind: 'text'
  result: ScaleResult
}

export interface JobSuccessVector {
  kind: 'vector'
  result: VectorRelevanceResult
}

export interface JobSuccessSerialization {
  kind: 'serialization'
  result: SerializationResult
}

export interface JobSuccessMutation {
  kind: 'mutation'
  result: MutationResult | null
}

export interface JobSuccessRelevance {
  kind: 'relevance'
  result: RelevanceQualityResult
}

export type JobSuccess =
  | JobSuccessText
  | JobSuccessVector
  | JobSuccessSerialization
  | JobSuccessMutation
  | JobSuccessRelevance

export interface JobFailure {
  kind: 'error'
  message: string
  stack?: string
}

export type JobOutcome = JobSuccess | JobFailure

export function isJobOutcome(value: unknown): value is JobOutcome {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.kind !== 'string') return false
  return (
    record.kind === 'text' ||
    record.kind === 'vector' ||
    record.kind === 'serialization' ||
    record.kind === 'mutation' ||
    record.kind === 'relevance' ||
    record.kind === 'error'
  )
}
