import type { PatternSearch } from '../../types/pattern'

export interface PatternIndexArrays {
  fieldPath: string
  docIds: Uint32Array
  runs: Uint32Array
  offsets: Uint32Array
  postings: Uint32Array
}

export interface PatternIndexReader {
  documents(): Uint32Array
  postings(first: number, second: number, third: number): Uint32Array
  toArrays(fieldPath: string, remap: Int32Array | null): PatternIndexArrays
  bytes(): number
}

export interface PatternIndexWriter extends PatternIndexReader {
  add(ordinal: number, value: unknown): void
  remove(ordinal: number, value: unknown): void
  addArrays(arrays: PatternIndexArrays, mapOrdinal: (ordinal: number) => number): void
  clear(): void
}

export interface PatternHost {
  appendFolded(text: string, out: number[]): void
}

export interface PatternWorkMeter {
  readonly matcherStateBytes: number
  add(units: number): void
  remaining(): number
}

export type PatternOperator = 'eq' | 'startsWith' | 'endsWith' | 'contains'

export interface PatternMatchRequest {
  readonly operator: PatternOperator
  readonly text: string
  readonly caseFold: boolean
  readonly index: PatternIndexReader
  readonly capacity: number
  readonly meter: PatternWorkMeter
  readonly host: PatternHost
  valueOf(ordinal: number): unknown
}

export interface PatternMergeInput {
  readonly arrays: PatternIndexArrays
  readonly remap: Int32Array
}

export interface PatternSearchModule extends PatternSearch {
  createIndex(host: PatternHost): PatternIndexWriter
  readArrays(arrays: PatternIndexArrays): PatternIndexReader
  mergeArrays(fieldPath: string, inputs: readonly PatternMergeInput[]): PatternIndexArrays
  matchBitset(request: PatternMatchRequest): Uint32Array
}
