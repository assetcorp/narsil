import type { FilterExpression } from '../../types/filters'
import type { SerializedPatternIndex } from '../../types/internal'
import type { PatternSearch } from '../../types/pattern'
import type { SearchClock } from '../search-clock'

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
  appendFoldedCodePoint(codePoint: number, out: number[]): void
  singleFolds(): ReadonlyMap<number, number>
}

export interface PatternFilterContext {
  isPatternField(fieldPath: string): boolean
  matchPattern(
    fieldPath: string,
    operator: PatternOperator,
    text: string,
    caseFold: boolean,
    tolerance: PatternTolerance,
    into: Uint32Array,
  ): void
  presentBitset(fieldPath: string): Uint32Array
  readonly capacity: number
  readonly allDocIdsBitset: Uint32Array
}

export interface PatternWorkMeter {
  readonly matcherStateBytes: number
  readonly flushUnits: number
  add(units: number): void
  remaining(): number
  readonly clock: SearchClock | undefined
}

export type ExpressionOperator = 'wildcard' | 'regex'

export type PatternOperator = 'eq' | 'startsWith' | 'endsWith' | 'contains' | ExpressionOperator

export type PatternTolerance = 0 | 1 | 2 | 'auto'

export interface PatternMatchRequest {
  readonly operator: PatternOperator
  readonly text: string
  readonly caseFold: boolean
  readonly tolerance: PatternTolerance
  readonly index: PatternIndexReader
  readonly matches: Uint32Array
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
  matchInto(request: PatternMatchRequest): void
  checkExpression(
    operator: ExpressionOperator,
    text: string,
    caseFold: boolean,
    fieldPath: string,
    host: PatternHost,
  ): void
  expressionFootprint(operator: ExpressionOperator, text: string, caseFold: boolean, host: PatternHost): number
  largestFootprint(expression: FilterExpression, patternFields: ReadonlySet<string>, host: PatternHost): number | null
  checkOperands(fieldPath: string, filter: Record<string, unknown>, host: PatternHost): void
  evaluateTests(
    fieldPath: string,
    filter: Record<string, unknown>,
    context: PatternFilterContext,
    bitsets: Uint32Array[],
  ): void
  serializeIndex(
    fieldPath: string,
    index: PatternIndexReader,
    toExternal: (ordinal: number) => string | undefined,
  ): SerializedPatternIndex
  decodeIndex(fieldPath: string, entry: SerializedPatternIndex): PatternIndexArrays
}
