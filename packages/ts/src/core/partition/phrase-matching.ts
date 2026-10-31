import type { AnalysedPhrase, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetIsEmpty, bitsetSet, createBitSet } from '../bitset'
import type { InvertedIndexReader } from '../inverted-index'
import type { PatternWorkMeter } from '../pattern-index/types'
import { PHRASE_ROWS_START, PHRASE_SORT_CLOCK_ROWS, PHRASE_SORT_RADIX_BITS } from './constants'
import { GrowableUint32 } from './growable-uint32'

const UINT32_BITS = 32

interface TokenRows {
  list: PostingListView
  keys: ArrayLike<number>
  order: Uint32Array | null
  fields: ArrayLike<number>
  store: Uint32Array
  count: number
  cursor: number
  positionRow: number
}

interface ResolvedPhrase {
  phrase: AnalysedPhrase
  rows: TokenRows[]
  entryRows: TokenRows[]
  lead: TokenRows
  leadOffset: number
}

export interface PhraseRows {
  phrase: AnalysedPhrase
  lists: ReadonlyArray<PostingListView>
  docIds: GrowableUint32
  fieldIndices: GrowableUint32
  frequencies: GrowableUint32
}

export interface PhraseMatches {
  matched: Uint32Array
  rows: PhraseRows[]
}

class WorkTally {
  private pending = 0

  constructor(private readonly meter: PatternWorkMeter | undefined) {}

  add(units: number): void {
    this.pending += units
    if (this.meter !== undefined && this.pending >= this.meter.flushUnits) this.flush()
  }

  tickClock(units: number): void {
    this.meter?.clock?.tick(units)
  }

  flush(): void {
    const units = this.pending
    this.pending = 0
    this.meter?.add(units)
  }
}

function placeRowsByDigit(
  docIds: ArrayLike<number>,
  from: Uint32Array,
  to: Uint32Array,
  shift: number,
  starts: Uint32Array,
  tally: WorkTally,
): void {
  const count = from.length
  const mask = starts.length - 1
  starts.fill(0)
  for (let row = 0; row < count; row++) starts[(docIds[row] >>> shift) & mask]++
  let next = 0
  for (let digit = 0; digit < starts.length; digit++) {
    const held = starts[digit]
    starts[digit] = next
    next += held
  }
  for (let begin = 0; begin < count; begin += PHRASE_SORT_CLOCK_ROWS) {
    const end = Math.min(count, begin + PHRASE_SORT_CLOCK_ROWS)
    for (let at = begin; at < end; at++) {
      const row = from[at]
      to[starts[(docIds[row] >>> shift) & mask]++] = row
    }
    tally.tickClock(end - begin)
  }
}

function sortedRowOrder(docIds: ArrayLike<number>, count: number, tally: WorkTally): Uint32Array {
  let order = new Uint32Array(count)
  for (let row = 0; row < count; row++) order[row] = row
  let spare = new Uint32Array(count)
  const starts = new Uint32Array(1 << PHRASE_SORT_RADIX_BITS)
  for (let shift = 0; shift < UINT32_BITS; shift += PHRASE_SORT_RADIX_BITS) {
    placeRowsByDigit(docIds, order, spare, shift, starts, tally)
    const placed = spare
    spare = order
    order = placed
  }
  return order
}

function tokenRowsOf(list: PostingListView, tally: WorkTally): TokenRows | null {
  const store = list.positionStore ?? null
  if (store === null) return null
  const count = list.length
  const docIds = list.docIds
  if (list.ordered) {
    return { list, keys: docIds, order: null, fields: list.fieldNameIndices, store, count, cursor: 0, positionRow: 0 }
  }
  tally.add(count)
  const order = sortedRowOrder(docIds, count, tally)
  const keys = new Uint32Array(count)
  for (let row = 0; row < count; row++) keys[row] = docIds[order[row]]
  return { list, keys, order, fields: list.fieldNameIndices, store, count, cursor: 0, positionRow: 0 }
}

function resolvePhrase(
  index: InvertedIndexReader,
  phrase: AnalysedPhrase,
  sharedRows: Map<string, TokenRows>,
  tally: WorkTally,
): ResolvedPhrase | null {
  const entryRows: TokenRows[] = []
  const rows: TokenRows[] = []
  for (const token of phrase.tokens) {
    let found = sharedRows.get(token)
    if (found === undefined) {
      const list = index.lookupReadOnce?.(token) ?? index.lookup(token)
      if (list === undefined) return null
      const built = tokenRowsOf(list, tally)
      if (built === null) return null
      found = built
      sharedRows.set(token, found)
    }
    if (!rows.includes(found)) rows.push(found)
    entryRows.push(found)
  }
  let leadEntry = 0
  for (let entry = 1; entry < entryRows.length; entry++) {
    if (entryRows[entry].count < entryRows[leadEntry].count) leadEntry = entry
  }
  return { phrase, rows, entryRows, lead: entryRows[leadEntry], leadOffset: phrase.offsets[leadEntry] }
}

function firstRowFor(rows: TokenRows, doc: number): number {
  const { keys, count } = rows
  let low = rows.cursor < count && keys[rows.cursor] <= doc ? rows.cursor : 0
  let high = low
  let step = 1
  while (high < count && keys[high] < doc) {
    low = high + 1
    high += step
    step *= 2
  }
  if (high > count) high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (keys[middle] < doc) low = middle + 1
    else high = middle
  }
  rows.cursor = low
  return low
}

function positionRowFor(rows: TokenRows, doc: number, field: number): number {
  const { keys, order, fields, count } = rows
  for (let at = firstRowFor(rows, doc); at < count && keys[at] === doc; at++) {
    const row = order === null ? at : order[at]
    if (fields[row] === field) return row
  }
  return -1
}

function countPhraseStarts(
  resolved: ResolvedPhrase,
  leadRow: number,
  cursors: Int32Array,
  ends: Int32Array,
  tally: WorkTally,
): number {
  const { entryRows, lead, leadOffset, phrase } = resolved
  const offsets = phrase.offsets
  for (let entry = 0; entry < entryRows.length; entry++) {
    const rows = entryRows[entry]
    const start = rows.list.positionStartAt?.(rows.positionRow) ?? 0
    cursors[entry] = start
    ends[entry] = start + (rows.list.positionCountAt?.(rows.positionRow) ?? 0)
  }

  const leadStore = lead.store
  const leadStart = lead.list.positionStartAt?.(leadRow) ?? 0
  const leadEnd = leadStart + (lead.list.positionCountAt?.(leadRow) ?? 0)
  let starts = 0
  for (let at = leadStart; at < leadEnd; at++) {
    const anchor = leadStore[at] - leadOffset
    if (anchor < 0) continue
    let holdsEveryEntry = true
    for (let entry = 0; entry < entryRows.length; entry++) {
      const store = entryRows[entry].store
      const wanted = anchor + offsets[entry]
      let cursor = cursors[entry]
      const end = ends[entry]
      let compared = 1
      while (cursor < end && store[cursor] < wanted) {
        cursor++
        compared++
      }
      cursors[entry] = cursor
      tally.add(compared)
      if (cursor === end) {
        return starts
      }
      if (store[cursor] !== wanted) {
        holdsEveryEntry = false
        break
      }
    }
    if (holdsEveryEntry) starts++
  }
  return starts
}

function collectPhraseRows(
  resolved: ResolvedPhrase,
  searchable: Uint8Array,
  allowed: Uint32Array | undefined,
  capacity: number,
  keepRows: boolean,
  tally: WorkTally,
): { hits: Uint32Array; rows: PhraseRows } {
  const hits = createBitSet(capacity)
  const collected: PhraseRows = {
    phrase: resolved.phrase,
    lists: resolved.entryRows.map(rows => rows.list),
    docIds: new GrowableUint32(PHRASE_ROWS_START),
    fieldIndices: new GrowableUint32(PHRASE_ROWS_START),
    frequencies: new GrowableUint32(PHRASE_ROWS_START),
  }
  const { lead, rows } = resolved
  const leadList = lead.list
  const docIds = leadList.docIds
  const fields = leadList.fieldNameIndices
  const deleted = leadList.deletedDocs
  const hasDeleted = deleted.size > 0
  const cursors = new Int32Array(resolved.entryRows.length)
  const ends = new Int32Array(resolved.entryRows.length)
  for (const each of rows) each.cursor = 0

  for (let leadRow = 0; leadRow < lead.count; leadRow++) {
    tally.add(1)
    const doc = docIds[leadRow]
    const field = fields[leadRow]
    if (searchable[field] === 0) continue
    if (hasDeleted && deleted.has(doc)) continue
    if (allowed !== undefined && !bitsetHas(allowed, doc)) continue

    let holdsEveryToken = true
    for (const each of rows) {
      if (each === lead) {
        each.positionRow = leadRow
        continue
      }
      const row = positionRowFor(each, doc, field)
      if (row === -1) {
        holdsEveryToken = false
        break
      }
      each.positionRow = row
    }
    if (!holdsEveryToken) continue

    const starts = countPhraseStarts(resolved, leadRow, cursors, ends, tally)
    if (starts === 0) continue
    bitsetSet(hits, doc)
    if (keepRows) {
      collected.docIds.push(doc)
      collected.fieldIndices.push(field)
      collected.frequencies.push(starts)
    }
  }
  return { hits, rows: collected }
}

export function matchPhrases(
  index: InvertedIndexReader,
  phrases: readonly AnalysedPhrase[],
  searchable: Uint8Array,
  filterBitset: Uint32Array | undefined,
  capacity: number,
  meter: PatternWorkMeter | undefined,
  keepRows: boolean,
): PhraseMatches {
  const tally = new WorkTally(meter)
  const sharedRows = new Map<string, TokenRows>()
  const resolved: ResolvedPhrase[] = []
  for (const phrase of phrases) {
    const found = resolvePhrase(index, phrase, sharedRows, tally)
    if (found === null) {
      tally.flush()
      return { matched: createBitSet(capacity), rows: [] }
    }
    resolved.push(found)
  }
  resolved.sort((first, second) => first.lead.count - second.lead.count)

  const rows: PhraseRows[] = []
  let allowed = filterBitset
  for (const each of resolved) {
    const collected = collectPhraseRows(each, searchable, allowed, capacity, keepRows, tally)
    allowed = collected.hits
    rows.push(collected.rows)
    if (bitsetIsEmpty(allowed)) break
  }
  tally.flush()
  return { matched: allowed ?? createBitSet(capacity), rows }
}
