import type { PostingListView } from '../../types/internal'
import { KEYWORD_FIRST_LISTS, KEYWORD_FIRST_ROWS, KEYWORD_FIRST_SLOTS } from './constants'
import {
  GROUP_SLOT,
  LIST_FROM_ROWS,
  LIST_ORDERED,
  LIST_STRIDE,
  LIST_VALUE_STRIDE,
  PHRASE_SLOT,
  SETTING_ANCHOR,
  SETTING_CAPACITY,
  SETTING_COLLECT,
  SETTING_COUNT,
  SETTING_LIMIT,
  SETTING_MIN_SCORE,
  SETTING_SLOTS,
  SETTING_TERM_MATCH,
  SETTING_TERMS,
  SETTING_TOTAL_DOCUMENTS,
  SLOT_KIND,
  SLOT_LIST_END,
  SLOT_STRIDE,
  SLOT_TERM,
  SLOT_VALUE_END,
  TERM_SLOT,
} from './layout'

export interface KeywordPostingPool {
  readonly docIds: Uint32Array
  readonly frequencies: Uint16Array
  readonly fields: Uint16Array
}

export interface KeywordFieldScoring {
  readonly searchable: Uint8Array
  readonly partialMarks: Uint8Array
  readonly nameRanks: Uint16Array
  readonly numbers: Float64Array
  readonly lengths: ReadonlyArray<Uint32Array | null>
}

export interface KeywordRequest {
  readonly pool: KeywordPostingPool
  readonly rowDocIds: Uint32Array
  readonly rowFrequencies: Float64Array
  readonly rowFields: Uint16Array
  readonly slots: Uint32Array
  readonly lists: Uint32Array
  readonly listValues: Float64Array
  readonly slotValues: Float64Array
  readonly fields: KeywordFieldScoring
  readonly filter: Uint32Array | null
  readonly live: Uint32Array
  readonly removed: Uint32Array
  readonly settings: Float64Array
}

export interface KeywordOutput {
  ordinals: Int32Array
  scores: Float64Array
  matched: Uint32Array
  readonly outcome: Float64Array
}

export interface KeywordScope {
  readonly fields: KeywordFieldScoring
  readonly filter: Uint32Array | null
  readonly live: Uint32Array
  readonly removed: Uint32Array
  readonly capacity: number
}

export interface KeywordSelection {
  readonly terms: number
  readonly totalDocuments: number
  readonly termMatch: number
  readonly anchor: number
  readonly limit: number
  readonly minScore: number
  readonly collect: boolean
}

export interface PhraseRowColumns {
  readonly docIds: ArrayLike<number>
  readonly fields: ArrayLike<number>
  readonly frequencies: ArrayLike<number>
  readonly count: number
}

const FIRST_SLOTS = KEYWORD_FIRST_SLOTS
const FIRST_LISTS = KEYWORD_FIRST_LISTS
const FIRST_ROWS = KEYWORD_FIRST_ROWS
const EMPTY_POOL: KeywordPostingPool = {
  docIds: new Uint32Array(0),
  frequencies: new Uint16Array(0),
  fields: new Uint16Array(0),
}

type RequestColumn = Uint32Array | Float64Array | Uint16Array

function grown<Column extends RequestColumn>(values: Column, needed: number): Column {
  if (values.length >= needed) return values
  const sized = new (values.constructor as new (length: number) => Column)(Math.max(needed, values.length * 2))
  sized.set(values)
  return sized
}

function sharesPool(column: ArrayLike<number>, pooled: Uint32Array | Uint16Array, start: number): boolean {
  if (!(column instanceof Uint32Array || column instanceof Uint16Array)) return false
  if (column.buffer !== pooled.buffer || column.BYTES_PER_ELEMENT !== pooled.BYTES_PER_ELEMENT) return false
  return column.byteOffset - pooled.byteOffset === start * pooled.BYTES_PER_ELEMENT
}

export class KeywordRequestBuilder {
  private pool: KeywordPostingPool = EMPTY_POOL
  private slots: Uint32Array = new Uint32Array(FIRST_SLOTS * SLOT_STRIDE)
  private slotCount = 0
  private lists: Uint32Array = new Uint32Array(FIRST_LISTS * LIST_STRIDE)
  private listCount = 0
  private listValues: Float64Array = new Float64Array(FIRST_LISTS * LIST_VALUE_STRIDE)
  private slotValues: Float64Array = new Float64Array(FIRST_SLOTS)
  private valueCount = 0
  private rowDocIds: Uint32Array = new Uint32Array(FIRST_ROWS)
  private rowFrequencies: Float64Array = new Float64Array(FIRST_ROWS)
  private rowFields: Uint16Array = new Uint16Array(FIRST_ROWS)
  private rowCount = 0
  private readonly settings = new Float64Array(SETTING_COUNT)

  begin(pool: KeywordPostingPool | null): void {
    this.pool = pool ?? EMPTY_POOL
    this.slotCount = 0
    this.listCount = 0
    this.valueCount = 0
    this.rowCount = 0
  }

  release(): void {
    this.pool = EMPTY_POOL
  }

  get slotsWritten(): number {
    return this.slotCount
  }

  termSlot(term: number): void {
    this.openSlot(TERM_SLOT, term)
  }

  groupSlot(term: number, documentFrequency: number): void {
    this.openSlot(GROUP_SLOT, term)
    this.pushSlotValue(documentFrequency)
  }

  phraseSlot(documentFrequencies: readonly number[], rows: PhraseRowColumns): void {
    this.openSlot(PHRASE_SLOT, 0)
    for (const frequency of documentFrequencies) this.pushSlotValue(frequency)
    const start = this.reserveRows(rows.count)
    let ordered = true
    for (let row = 0; row < rows.count; row++) {
      const at = start + row
      this.rowDocIds[at] = rows.docIds[row]
      this.rowFields[at] = rows.fields[row]
      this.rowFrequencies[at] = rows.frequencies[row]
      if (row > 0 && this.rowDocIds[at] < this.rowDocIds[at - 1]) ordered = false
    }
    this.pushList(LIST_FROM_ROWS | (ordered ? LIST_ORDERED : 0), start, rows.count, 0, 0)
  }

  termList(list: PostingListView, documentFrequency: number): void {
    this.addList(list, documentFrequency, 0)
  }

  memberList(list: PostingListView, factor: number, partialFactor: number): void {
    this.addList(list, factor, partialFactor)
  }

  request(scope: KeywordScope, selection: KeywordSelection): KeywordRequest {
    const settings = this.settings
    settings[SETTING_SLOTS] = this.slotCount
    settings[SETTING_TERMS] = selection.terms
    settings[SETTING_CAPACITY] = scope.capacity
    settings[SETTING_TOTAL_DOCUMENTS] = selection.totalDocuments
    settings[SETTING_TERM_MATCH] = selection.termMatch
    settings[SETTING_ANCHOR] = selection.anchor
    settings[SETTING_LIMIT] = selection.limit
    settings[SETTING_MIN_SCORE] = selection.minScore
    settings[SETTING_COLLECT] = selection.collect ? 1 : 0
    return {
      pool: this.pool,
      rowDocIds: this.rowDocIds,
      rowFrequencies: this.rowFrequencies,
      rowFields: this.rowFields,
      slots: this.slots,
      lists: this.lists,
      listValues: this.listValues,
      slotValues: this.slotValues,
      fields: scope.fields,
      filter: scope.filter,
      live: scope.live,
      removed: scope.removed,
      settings,
    }
  }

  private openSlot(kind: number, term: number): void {
    this.slots = grown(this.slots, (this.slotCount + 1) * SLOT_STRIDE)
    const base = this.slotCount * SLOT_STRIDE
    this.slots[base + SLOT_KIND] = kind
    this.slots[base + SLOT_TERM] = term
    this.slots[base + SLOT_LIST_END] = this.listCount
    this.slots[base + SLOT_VALUE_END] = this.valueCount
    this.slotCount++
  }

  private pushSlotValue(value: number): void {
    this.slotValues = grown(this.slotValues, this.valueCount + 1)
    this.slotValues[this.valueCount++] = value
    this.slots[(this.slotCount - 1) * SLOT_STRIDE + SLOT_VALUE_END] = this.valueCount
  }

  private pushList(flags: number, start: number, length: number, first: number, second: number): void {
    this.lists = grown(this.lists, (this.listCount + 1) * LIST_STRIDE)
    this.listValues = grown(this.listValues, (this.listCount + 1) * LIST_VALUE_STRIDE)
    const base = this.listCount * LIST_STRIDE
    this.lists[base] = flags
    this.lists[base + 1] = start
    this.lists[base + 2] = length
    this.listValues[this.listCount * LIST_VALUE_STRIDE] = first
    this.listValues[this.listCount * LIST_VALUE_STRIDE + 1] = second
    this.listCount++
    this.slots[(this.slotCount - 1) * SLOT_STRIDE + SLOT_LIST_END] = this.listCount
  }

  private reserveRows(count: number): number {
    const start = this.rowCount
    const needed = start + count
    this.rowDocIds = grown(this.rowDocIds, needed)
    this.rowFrequencies = grown(this.rowFrequencies, needed)
    this.rowFields = grown(this.rowFields, needed)
    this.rowCount = needed
    return start
  }

  private addList(list: PostingListView, first: number, second: number): void {
    const docIds = list.docIds
    const frequencies = list.termFrequencies
    const fields = list.fieldNameIndices
    const length = Math.min(list.length, docIds.length, frequencies.length, fields.length)
    const orderedFlag = list.ordered ? LIST_ORDERED : 0
    const pool = this.pool
    if (docIds instanceof Uint32Array && docIds.buffer === pool.docIds.buffer) {
      const start = (docIds.byteOffset - pool.docIds.byteOffset) / Uint32Array.BYTES_PER_ELEMENT
      if (
        Number.isInteger(start) &&
        start >= 0 &&
        start + length <= pool.docIds.length &&
        start + length <= pool.frequencies.length &&
        start + length <= pool.fields.length &&
        sharesPool(frequencies, pool.frequencies, start) &&
        sharesPool(fields, pool.fields, start)
      ) {
        this.pushList(orderedFlag, start, length, first, second)
        return
      }
    }
    const start = this.reserveRows(length)
    for (let row = 0; row < length; row++) {
      this.rowDocIds[start + row] = docIds[row]
      this.rowFrequencies[start + row] = frequencies[row]
      this.rowFields[start + row] = fields[row]
    }
    this.pushList(LIST_FROM_ROWS | orderedFlag, start, length, first, second)
  }
}
