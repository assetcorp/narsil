import type {
  LatencySummary,
  MutationResult,
  RelevanceQualityResult,
  ScaleResult,
  SerializationResult,
  VectorRelevanceResult,
} from '../types'

export type FailurePhase = 'text-tier' | 'vector-tier' | 'serialization-tier' | 'mutation-tier' | 'relevance-tier'

const EMPTY_LATENCY: LatencySummary = {
  samples: 0,
  meanMs: 0,
  p50Ms: 0,
  p90Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
  ciLowerMs: 0,
  ciUpperMs: 0,
}

export type FailureCode =
  | 'engine-threw'
  | 'engine-exited'
  | 'engine-signal'
  | 'engine-killed'
  | 'engine-timeout'
  | 'engine-ipc-corrupt'
  | 'engine-disconnect'

export interface FailureRecord {
  code: FailureCode
  message: string
  phase: FailurePhase
  engine: string
  scale?: number
  dimension?: number
  dataset?: string
  exitCode?: number | null
  signal?: string | null
  stack?: string
}

export interface ScaleResultWithError extends ScaleResult {
  error?: FailureRecord
}

export interface VectorRelevanceResultWithError extends VectorRelevanceResult {
  error?: FailureRecord
}

export interface SerializationResultWithError extends SerializationResult {
  error?: FailureRecord
}

export interface MutationResultWithError extends MutationResult {
  error?: FailureRecord
}

export interface RelevanceQualityResultWithError extends RelevanceQualityResult {
  error?: FailureRecord
}

export function makeScaleErrorRecord(failure: FailureRecord): ScaleResultWithError {
  return {
    insertMedianMs: -1,
    insertDocsPerSec: -1,
    insertCV: 0,
    searchMedianMs: -1,
    searchP95Ms: -1,
    searchCV: 0,
    searchStdDevMs: 0,
    memoryMb: -1,
    error: failure,
  }
}

export function makeVectorErrorRecord(failure: FailureRecord, dataset: string): VectorRelevanceResultWithError {
  return {
    dataset,
    model: 'unknown',
    dim: -1,
    docCount: -1,
    queryCount: -1,
    insertMedianMs: -1,
    insertDocsPerSec: -1,
    memoryMb: -1,
    searchLatency: EMPTY_LATENCY,
    meanRecallAt10: -1,
    error: failure,
  }
}

export function makeSerializationErrorRecord(failure: FailureRecord): SerializationResultWithError {
  return {
    serializeMs: -1,
    serializedBytes: -1,
    deserializeAndSearchMs: -1,
    error: failure,
  }
}

export function makeMutationErrorRecord(failure: FailureRecord): MutationResultWithError {
  return {
    removeDocsPerSec: -1,
    removeMedianMs: -1,
    searchAfterRemoveMedianMs: -1,
    reinsertDocsPerSec: -1,
    error: failure,
  }
}

export function makeRelevanceErrorRecord(
  failure: FailureRecord,
  dataset: string,
  docCount: number,
  queryCount: number,
): RelevanceQualityResultWithError {
  return {
    dataset,
    meanNdcg10: -1,
    meanPrecision10: -1,
    meanMap: -1,
    meanMrr: -1,
    queryCount,
    docCount,
    error: failure,
  }
}

export function formatFailureLine(failure: FailureRecord): string {
  const parts = [`code=${failure.code}`]
  if (failure.exitCode !== undefined && failure.exitCode !== null) parts.push(`exit=${failure.exitCode}`)
  if (failure.signal !== undefined && failure.signal !== null) parts.push(`signal=${failure.signal}`)
  parts.push(`message=${failure.message}`)
  return parts.join(' ')
}

export const STRING_SERIALIZATION_LIMIT_LABEL =
  "json serialization exceeds the V8 single-string limit (~512MB); this is a limit of the engine's shipped json format at this scale"

export const STRING_SERIALIZATION_LIMIT_CELL = 'json exceeds V8 ~512MB string limit'

function isStringLengthLimit(failure: FailureRecord): boolean {
  return failure.phase === 'serialization-tier' && /invalid string length/i.test(failure.message)
}

export function describeSerializationLimit(failure: FailureRecord | undefined): string | null {
  if (!failure) return null
  if (isStringLengthLimit(failure)) return STRING_SERIALIZATION_LIMIT_LABEL
  return null
}
