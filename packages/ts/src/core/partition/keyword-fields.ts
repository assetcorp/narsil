import type { BM25Params } from '../../types/schema'
import { DEFAULT_BM25_B, DEFAULT_BM25_K1 } from '../constants'
import { FIELD_AVERAGE_LENGTHS, FIELD_B, FIELD_BOOSTS, FIELD_K1, FIELD_NUMBER_COLUMNS } from '../keyword-score/layout'
import type { KeywordFieldScoring } from '../keyword-score/request'
import { compareCodePoints } from '../ordering/code-points'
import type { PartitionReadState } from './read-state'

interface FieldColumns {
  searchable: Uint8Array
  partialMarks: Uint8Array
  nameRanks: Uint16Array
  numbers: Float64Array
  lengths: Array<Uint32Array | null>
  rankedNames: readonly string[] | null
}

const columns: FieldColumns = {
  searchable: new Uint8Array(0),
  partialMarks: new Uint8Array(0),
  nameRanks: new Uint16Array(0),
  numbers: new Float64Array(0),
  lengths: [],
  rankedNames: null,
}

function sizedFor(fieldCount: number): void {
  if (columns.searchable.length === fieldCount) return
  columns.searchable = new Uint8Array(fieldCount)
  columns.partialMarks = new Uint8Array(fieldCount)
  columns.nameRanks = new Uint16Array(fieldCount)
  columns.numbers = new Float64Array(fieldCount * FIELD_NUMBER_COLUMNS)
  columns.lengths = new Array<Uint32Array | null>(fieldCount).fill(null)
  columns.rankedNames = null
}

function rankNames(names: readonly string[]): void {
  if (columns.rankedNames === names) return
  const order = names.map((_, index) => index).sort((left, right) => compareCodePoints(names[left], names[right]))
  for (let rank = 0; rank < order.length; rank++) columns.nameRanks[order[rank]] = rank
  columns.rankedNames = names
}

export function loadKeywordFields(
  state: PartitionReadState,
  fields: readonly string[] | undefined,
  boost: Readonly<Record<string, number>> | undefined,
  averageFieldLengths: Readonly<Record<string, number>>,
  bm25: BM25Params | undefined,
  partialFields: readonly string[] | undefined,
): KeywordFieldScoring {
  const names = state.fieldNameTable.names
  const fieldCount = names.length
  sizedFor(fieldCount)
  rankNames(names)
  const k1 = bm25?.k1 ?? DEFAULT_BM25_K1
  const b = bm25?.b ?? DEFAULT_BM25_B
  const perField = bm25?.fields
  const { searchable, partialMarks, numbers, lengths } = columns
  for (let field = 0; field < fieldCount; field++) {
    const name = names[field]
    searchable[field] = fields === undefined || fields.includes(name) ? 1 : 0
    partialMarks[field] = partialFields?.includes(name) ? 1 : 0
    numbers[FIELD_BOOSTS * fieldCount + field] = boost?.[name] ?? 1
    numbers[FIELD_AVERAGE_LENGTHS * fieldCount + field] = averageFieldLengths[name] ?? 1
    const pair = perField !== undefined && Object.hasOwn(perField, name) ? perField[name] : undefined
    numbers[FIELD_K1 * fieldCount + field] = pair?.k1 ?? k1
    numbers[FIELD_B * fieldCount + field] = pair?.b ?? b
    lengths[field] = state.docStore.fieldLengthColumn(name)
  }
  return columns
}
