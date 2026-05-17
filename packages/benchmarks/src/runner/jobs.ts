import type {
  CranfieldQualityResult,
  MutationResult,
  QualityResult,
  ScaleResult,
  SerializationResult,
  VectorScaleResult,
} from '../types'

export type EngineId = 'narsil' | 'orama' | 'minisearch'

export type AdapterKind = 'text-only' | 'full-schema' | 'serializable' | 'vector'

export type DataSource = 'wiki' | 'synthetic'

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
  scale: number
  dimension: number
  seed: number
  searchQueryCount: number
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

export interface QualityJobSpec {
  kind: 'quality'
  engine: EngineId
  docCount: number
  queryCount: number
  dataSource: DataSource
  seed: number
}

export interface CranfieldJobSpec {
  kind: 'cranfield'
  engine: EngineId
  fixturesDir: string
}

export type JobSpec =
  | TextJobSpec
  | VectorJobSpec
  | SerializationJobSpec
  | MutationJobSpec
  | QualityJobSpec
  | CranfieldJobSpec

export interface JobSuccessText {
  kind: 'text'
  result: ScaleResult
}

export interface JobSuccessVector {
  kind: 'vector'
  result: VectorScaleResult
}

export interface JobSuccessSerialization {
  kind: 'serialization'
  result: SerializationResult
}

export interface JobSuccessMutation {
  kind: 'mutation'
  result: MutationResult | null
}

export interface JobSuccessQuality {
  kind: 'quality'
  result: QualityResult
}

export interface JobSuccessCranfield {
  kind: 'cranfield'
  result: CranfieldQualityResult
}

export type JobSuccess =
  | JobSuccessText
  | JobSuccessVector
  | JobSuccessSerialization
  | JobSuccessMutation
  | JobSuccessQuality
  | JobSuccessCranfield

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
    record.kind === 'quality' ||
    record.kind === 'cranfield' ||
    record.kind === 'error'
  )
}
