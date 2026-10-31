import type { BM25Params } from '../../types/schema'
import { DEFAULT_BM25_B, DEFAULT_BM25_K1 } from '../constants'
import { computeBM25WithIDF } from '../scorer'
import type { PartitionReadState } from './read-state'

export interface FieldScoring {
  searchable: Uint8Array
  boosts: Float64Array
  averageLengths: Float64Array
  lengthColumns: Array<Uint32Array | null>
  k1s: Float64Array
  bs: Float64Array
  boundPairs: Float64Array
}

function differentPairsOf(searchable: Uint8Array, k1s: Float64Array, bs: Float64Array): Float64Array {
  const pairs: number[] = []
  for (let fieldIndex = 0; fieldIndex < searchable.length; fieldIndex++) {
    if (searchable[fieldIndex] !== 1) continue
    let seen = false
    for (let at = 0; at < pairs.length && !seen; at += 2) {
      seen = pairs[at] === k1s[fieldIndex] && pairs[at + 1] === bs[fieldIndex]
    }
    if (!seen) pairs.push(k1s[fieldIndex], bs[fieldIndex])
  }
  return Float64Array.from(pairs)
}

export function loadFieldScoring(
  state: PartitionReadState,
  fields: readonly string[] | undefined,
  boost: Readonly<Record<string, number>> | undefined,
  averageFieldLengths: Readonly<Record<string, number>>,
  bm25: BM25Params | undefined,
): FieldScoring {
  const fieldNames = state.fieldNameTable.names
  const fieldCount = fieldNames.length
  const k1 = bm25?.k1 ?? DEFAULT_BM25_K1
  const b = bm25?.b ?? DEFAULT_BM25_B
  const perField = bm25?.fields
  const scoring: FieldScoring = {
    searchable: new Uint8Array(fieldCount),
    boosts: new Float64Array(fieldCount),
    averageLengths: new Float64Array(fieldCount),
    lengthColumns: new Array<Uint32Array | null>(fieldCount).fill(null),
    k1s: new Float64Array(fieldCount),
    bs: new Float64Array(fieldCount),
    boundPairs: new Float64Array(0),
  }
  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
    const fieldName = fieldNames[fieldIndex]
    scoring.searchable[fieldIndex] = fields === undefined || fields.includes(fieldName) ? 1 : 0
    scoring.boosts[fieldIndex] = boost?.[fieldName] ?? 1
    scoring.averageLengths[fieldIndex] = averageFieldLengths[fieldName] ?? 1
    scoring.lengthColumns[fieldIndex] = state.docStore.fieldLengthColumn(fieldName)
    const fieldPair = perField !== undefined && Object.hasOwn(perField, fieldName) ? perField[fieldName] : undefined
    scoring.k1s[fieldIndex] = fieldPair?.k1 ?? k1
    scoring.bs[fieldIndex] = fieldPair?.b ?? b
  }
  scoring.boundPairs =
    perField === undefined ? Float64Array.of(k1, b) : differentPairsOf(scoring.searchable, scoring.k1s, scoring.bs)
  return scoring
}

export function fieldLengthOf(
  columns: ReadonlyArray<Uint32Array | null>,
  fieldIndex: number,
  internalId: number,
  averageLength: number,
): number {
  const column = fieldIndex < columns.length ? columns[fieldIndex] : null
  if (column === null || internalId >= column.length) return averageLength
  const stored = column[internalId]
  return stored > 0 ? stored : averageLength
}

export function bestSearchable(searchable: Uint8Array, values: Float64Array): number {
  let best = 0
  for (let index = 0; index < searchable.length; index++) {
    if (searchable[index] === 1 && values[index] > best) best = values[index]
  }
  return best
}

export function blockEntryBound(
  fields: FieldScoring,
  maxTermFrequency: number,
  idf: number,
  minFieldLength: number,
  maxAverageLength: number,
): number {
  const pairs = fields.boundPairs
  let best = 0
  for (let at = 0; at < pairs.length; at += 2) {
    const bound = computeBM25WithIDF(maxTermFrequency, idf, minFieldLength, maxAverageLength, pairs[at], pairs[at + 1])
    if (bound > best) best = bound
  }
  return best
}
