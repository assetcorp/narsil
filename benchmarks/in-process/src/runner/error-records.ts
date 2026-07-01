import type {
  CranfieldQualityResult,
  MutationResult,
  ScaleResult,
  SerializationResult,
  VectorScaleResult,
} from '../types'

export type FailurePhase = 'text-tier' | 'vector-tier' | 'serialization-tier' | 'mutation-tier' | 'cranfield-tier'

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
  exitCode?: number | null
  signal?: string | null
  stack?: string
}

export interface ScaleResultWithError extends ScaleResult {
  error?: FailureRecord
}

export interface VectorScaleResultWithError extends VectorScaleResult {
  error?: FailureRecord
}

export interface SerializationResultWithError extends SerializationResult {
  error?: FailureRecord
}

export interface MutationResultWithError extends MutationResult {
  error?: FailureRecord
}

export interface CranfieldQualityResultWithError extends CranfieldQualityResult {
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

export function makeVectorErrorRecord(failure: FailureRecord): VectorScaleResultWithError {
  return {
    insertMedianMs: -1,
    insertDocsPerSec: -1,
    searchMedianMs: -1,
    searchP95Ms: -1,
    memoryMb: -1,
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

export function makeCranfieldErrorRecord(
  failure: FailureRecord,
  docCount: number,
  queryCount: number,
): CranfieldQualityResultWithError {
  return {
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
