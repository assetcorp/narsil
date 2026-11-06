import {
  FIELD_AVERAGE_LENGTHS,
  FIELD_B,
  FIELD_BOOSTS,
  FIELD_K1,
  GROUP_SLOT,
  LIST_DOCUMENT_FREQUENCY,
  LIST_FACTOR,
  LIST_FROM_ROWS,
  LIST_PARTIAL_FACTOR,
  LIST_STRIDE,
  LIST_VALUE_STRIDE,
  PHRASE_SLOT,
  SETTING_SLOTS,
  SETTING_TOTAL_DOCUMENTS,
  SLOT_KIND,
  SLOT_LIST_END,
  SLOT_STRIDE,
  SLOT_VALUE_END,
} from '../keyword-score/layout'
import type { KeywordRequest } from '../keyword-score/request'
import { type RowKeys, sortRows } from '../keyword-score/rows'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import type { ScoreComponents } from './scoring'

interface ListRows {
  readonly keys: RowKeys
  readonly frequencies: ArrayLike<number>
  readonly byDocument: Map<number, Uint32Array>
}

interface GroupWinner {
  sum: number
  rows: number[]
  list: number
  source: ListRows
}

function holds(bits: Uint32Array, ordinal: number): boolean {
  const word = ordinal >>> 5
  return word < bits.length && ((bits[word] >>> (ordinal & 31)) & 1) === 1
}

function scorable(request: KeywordRequest, ordinal: number): boolean {
  if (!holds(request.live, ordinal) || holds(request.removed, ordinal)) return false
  return request.filter === null || holds(request.filter, ordinal)
}

function rowsOfList(request: KeywordRequest, list: number, wanted: ReadonlySet<number>): ListRows {
  const flags = request.lists[list * LIST_STRIDE]
  const start = request.lists[list * LIST_STRIDE + 1]
  const length = request.lists[list * LIST_STRIDE + 2]
  const fromRows = (flags & LIST_FROM_ROWS) !== 0
  const docIds = fromRows ? request.rowDocIds : request.pool.docIds
  const keys: RowKeys = {
    docIds,
    fields: fromRows ? request.rowFields : request.pool.fields,
    nameRanks: request.fields.nameRanks,
  }
  const gathered = new Map<number, number[]>()
  for (let row = start; row < start + length; row++) {
    const ordinal = docIds[row]
    if (!wanted.has(ordinal)) continue
    const rows = gathered.get(ordinal)
    if (rows === undefined) gathered.set(ordinal, [row])
    else rows.push(row)
  }
  const byDocument = new Map<number, Uint32Array>()
  for (const [ordinal, rows] of gathered) {
    const order = Uint32Array.from(rows)
    byDocument.set(ordinal, sortRows(keys, order, new Uint32Array(order.length), order.length))
  }
  return { keys, frequencies: fromRows ? request.rowFrequencies : request.pool.frequencies, byDocument }
}

function componentsOf(found: Map<number, ScoreComponents>, ordinal: number): ScoreComponents {
  let held = found.get(ordinal)
  if (held === undefined) {
    held = { termFrequencies: {}, fieldLengths: {}, idf: {} }
    found.set(ordinal, held)
  }
  return held
}

function lengthIn(request: KeywordRequest, field: number, ordinal: number): number {
  const fieldCount = request.fields.searchable.length
  const average = request.fields.numbers[FIELD_AVERAGE_LENGTHS * fieldCount + field]
  const column = request.fields.lengths[field]
  const stored = column !== null && ordinal < column.length ? column[ordinal] : 0
  return stored > 0 ? stored : average
}

function rowScore(request: KeywordRequest, frequency: number, idf: number, field: number, ordinal: number): number {
  const fieldCount = request.fields.searchable.length
  const numbers = request.fields.numbers
  const bm25 = computeBM25WithIDF(
    frequency,
    idf,
    lengthIn(request, field, ordinal),
    numbers[FIELD_AVERAGE_LENGTHS * fieldCount + field],
    numbers[FIELD_K1 * fieldCount + field],
    numbers[FIELD_B * fieldCount + field],
  )
  return bm25 * numbers[FIELD_BOOSTS * fieldCount + field]
}

function searchableField(request: KeywordRequest, field: number): boolean {
  return field < request.fields.searchable.length && request.fields.searchable[field] !== 0
}

function record(
  request: KeywordRequest,
  found: Map<number, ScoreComponents>,
  names: readonly string[],
  source: ListRows,
  rows: ArrayLike<number>,
  ordinal: number,
  label: string,
  idf: number,
): void {
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at]
    const field = source.keys.fields[row]
    if (!searchableField(request, field)) continue
    const components = componentsOf(found, ordinal)
    const name = names[field]
    components.termFrequencies[`${name}:${label}`] = source.frequencies[row]
    components.fieldLengths[name] = lengthIn(request, field, ordinal)
    components.idf[label] = idf
  }
}

function groupWinners(
  request: KeywordRequest,
  wanted: ReadonlySet<number>,
  listFrom: number,
  listEnd: number,
  idf: number,
): Map<number, GroupWinner> {
  const winners = new Map<number, GroupWinner>()
  for (let list = listFrom; list < listEnd; list++) {
    const factor = request.listValues[list * LIST_VALUE_STRIDE + LIST_FACTOR]
    const partialFactor = request.listValues[list * LIST_VALUE_STRIDE + LIST_PARTIAL_FACTOR]
    const source = rowsOfList(request, list, wanted)
    for (const [ordinal, rows] of source.byDocument) {
      if (!scorable(request, ordinal)) continue
      let sum = 0
      const kept: number[] = []
      for (const row of rows) {
        const field = source.keys.fields[row]
        if (!searchableField(request, field)) continue
        const rowFactor = request.fields.partialMarks[field] === 1 ? partialFactor : factor
        if (!(rowFactor > 0)) continue
        sum += rowScore(request, source.frequencies[row], idf, field, ordinal) * rowFactor
        kept.push(row)
      }
      if (kept.length === 0) continue
      const best = winners.get(ordinal)
      if (best === undefined || sum > best.sum) winners.set(ordinal, { sum, rows: kept, list, source })
    }
  }
  return winners
}

export function keywordComponents(
  request: KeywordRequest,
  labels: readonly string[],
  names: readonly string[],
  ordinals: ArrayLike<number>,
  count: number,
): Map<number, ScoreComponents> {
  const wanted = new Set<number>()
  for (let at = 0; at < count; at++) wanted.add(ordinals[at])
  const found = new Map<number, ScoreComponents>()
  const { slots, settings, listValues, slotValues } = request
  const totalDocuments = settings[SETTING_TOTAL_DOCUMENTS]
  for (let slot = 0; slot < settings[SETTING_SLOTS]; slot++) {
    const base = slot * SLOT_STRIDE
    const listFrom = slot === 0 ? 0 : slots[base - SLOT_STRIDE + SLOT_LIST_END]
    const listEnd = slots[base + SLOT_LIST_END]
    const valueFrom = slot === 0 ? 0 : slots[base - SLOT_STRIDE + SLOT_VALUE_END]
    const valueEnd = slots[base + SLOT_VALUE_END]
    const kind = slots[base + SLOT_KIND]
    if (kind === GROUP_SLOT) {
      const idf = computeIDF(slotValues[valueFrom], totalDocuments)
      for (const [ordinal, winner] of groupWinners(request, wanted, listFrom, listEnd, idf)) {
        record(request, found, names, winner.source, winner.rows, ordinal, labels[winner.list], idf)
      }
      continue
    }
    let phraseIdf = 0
    if (kind === PHRASE_SLOT) {
      for (let value = valueFrom; value < valueEnd; value++) phraseIdf += computeIDF(slotValues[value], totalDocuments)
    }
    for (let list = listFrom; list < listEnd; list++) {
      const idf =
        kind === PHRASE_SLOT
          ? phraseIdf
          : computeIDF(listValues[list * LIST_VALUE_STRIDE + LIST_DOCUMENT_FREQUENCY], totalDocuments)
      const source = rowsOfList(request, list, wanted)
      for (const [ordinal, rows] of source.byDocument) {
        if (scorable(request, ordinal)) record(request, found, names, source, rows, ordinal, labels[list], idf)
      }
    }
  }
  return found
}
