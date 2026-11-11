import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { PREPARED_TOKEN_GROWTH_FACTOR, PREPARED_TOKEN_START_CAPACITY } from './constants'
import { TextIndex } from './text-index'

const TOKEN_WORDS = 8
const ABSENT_TEXT = 0xffffffff
const NO_ROWS = new Uint32Array(0)
export const PREPARED_ROW_WORDS = 3

type PackedTokens = Pick<NativeFieldTokens, 'tokens' | 'units'>

export interface PreparedSegmentField {
  readonly field: number
  readonly text: PreparedFieldTokens
}

export interface PreparedFieldTokens {
  readonly count: number
  readonly texts: readonly string[] | null
  readonly rows: Uint32Array
  packing: PackedTokens | null
}

function packTokens(prepared: PreparedFieldTokens): PackedTokens {
  const texts = prepared.texts ?? []
  const offsets = new Uint32Array(texts.length).fill(ABSENT_TEXT)
  const referenced: number[] = []
  let length = 0
  const reference = (id: number): void => {
    if (id === ABSENT_TEXT || offsets[id] !== ABSENT_TEXT) return
    offsets[id] = length
    length += texts[id].length
    referenced.push(id)
  }
  const rows = prepared.rows
  for (let row = 0; row < prepared.count * PREPARED_ROW_WORDS; row += PREPARED_ROW_WORDS) {
    reference(rows[row])
    reference(rows[row + 1])
  }
  const units = new Uint16Array(length)
  for (const id of referenced) {
    const text = texts[id]
    const start = offsets[id]
    for (let at = 0; at < text.length; at++) units[start + at] = text.charCodeAt(at)
  }
  const tokens = new Uint32Array(prepared.count * TOKEN_WORDS)
  for (let record = 0; record < prepared.count; record++) {
    const at = record * TOKEN_WORDS
    const row = record * PREPARED_ROW_WORDS
    const term = rows[row]
    const surface = rows[row + 1]
    tokens[at] = rows[row + 2]
    tokens[at + 1] = offsets[term]
    tokens[at + 2] = texts[term].length
    tokens[at + 3] = surface === ABSENT_TEXT ? ABSENT_TEXT : offsets[surface]
    tokens[at + 4] = surface === ABSENT_TEXT ? 0 : texts[surface].length
    tokens[at + 7] = ABSENT_TEXT
  }
  return { tokens, units }
}

export function packedTokens(prepared: PreparedFieldTokens): PackedTokens {
  prepared.packing ??= packTokens(prepared)
  return prepared.packing
}

let spareRows: Uint32Array | null = null

function takeRows(): Uint32Array {
  const held = spareRows
  spareRows = null
  return held ?? new Uint32Array(PREPARED_TOKEN_START_CAPACITY * PREPARED_ROW_WORDS)
}

function returnRows(rows: Uint32Array): void {
  if (spareRows === null || spareRows.length < rows.length) spareRows = rows
}

export function packedFields(fields: readonly PreparedSegmentField[]): NativeFieldTokens[] {
  return fields.map(({ field, text }) => ({ field, ...packedTokens(text) }))
}

const sharedTextIds = new TextIndex()

export class DocumentTexts {
  readonly texts: string[] = []

  idOf(text: string): number {
    const texts = this.texts
    if (sharedTextIds.owner !== this) this.claim()
    const found = sharedTextIds.find(texts, text)
    if (found >= 0) return found
    const id = texts.length
    texts.push(text)
    sharedTextIds.insertMissed(texts, id)
    return id
  }

  release(): void {
    if (sharedTextIds.owner === this) sharedTextIds.clear()
  }

  private claim(): void {
    sharedTextIds.clear(this)
    for (let id = 0; id < this.texts.length; id++) sharedTextIds.insert(this.texts, id)
  }
}

export class PreparedTokens {
  private records: Uint32Array = new Uint32Array(0)
  private used = 0
  private offsets: Map<string, number> | null = null
  private units = 0
  private readonly pieces: Array<string | Uint16Array> = []
  private packed = false
  private readonly document: DocumentTexts
  private readonly ownsDocument: boolean
  private rows: Uint32Array | null = null
  private count = 0

  constructor(document?: DocumentTexts) {
    this.document = document ?? new DocumentTexts()
    this.ownsDocument = document === undefined
  }

  add(token: string, position: number, surface: string | undefined): void {
    if (this.packed) {
      this.addRecord(token, position, surface)
      return
    }
    const at = this.count * PREPARED_ROW_WORDS
    let rows = this.rows ?? takeRows()
    if (at === rows.length) rows = this.grownRows(rows)
    this.rows = rows
    const document = this.document
    rows[at] = document.idOf(token)
    rows[at + 1] = surface === undefined ? ABSENT_TEXT : document.idOf(surface)
    rows[at + 2] = position
    this.count++
  }

  append(tokens: Uint32Array, count: number, units: Uint16Array, unitCount: number, position: number): void {
    if (count === 0) return
    if (!this.packed) this.switchToRecords()
    const words = count * TOKEN_WORDS
    if (this.records.length === 0 && this.units === 0 && position === 0) {
      this.records = tokens.slice(1, 1 + words)
      this.pieces.push(units.slice(0, unitCount))
      this.used = words
      this.units = unitCount
      return
    }
    if (this.records.length === 0) this.records = new Uint32Array(words)
    else this.reserve(this.used + words)
    const records = this.records
    const shift = this.units
    for (let from = 1, to = this.used; from <= words; from += TOKEN_WORDS, to += TOKEN_WORDS) {
      const surface = tokens[from + 3]
      records[to] = tokens[from] + position
      records[to + 1] = tokens[from + 1] + shift
      records[to + 2] = tokens[from + 2]
      records[to + 3] = surface === ABSENT_TEXT ? ABSENT_TEXT : surface + shift
      records[to + 4] = tokens[from + 4]
      records[to + 5] = tokens[from + 5]
      records[to + 6] = tokens[from + 6]
      records[to + 7] = tokens[from + 7]
    }
    this.pieces.push(units.slice(0, unitCount))
    this.used += words
    this.units += unitCount
  }

  finish(): PreparedFieldTokens {
    const rows = this.rows
    this.rows = null
    if (this.ownsDocument) this.document.release()
    if (!this.packed) {
      const count = this.count
      if (rows === null) return { count, texts: this.document.texts, rows: NO_ROWS, packing: null }
      const kept = rows.slice(0, count * PREPARED_ROW_WORDS)
      returnRows(rows)
      return { count, texts: this.document.texts, rows: kept, packing: null }
    }
    if (rows !== null) returnRows(rows)
    const tokens = this.used === this.records.length ? this.records : this.records.slice(0, this.used)
    return {
      count: this.used / TOKEN_WORDS,
      texts: null,
      rows: NO_ROWS,
      packing: { tokens, units: this.joinedUnits() },
    }
  }

  private grownRows(rows: Uint32Array): Uint32Array {
    const grown = new Uint32Array(rows.length * PREPARED_TOKEN_GROWTH_FACTOR)
    grown.set(rows)
    return grown
  }

  private switchToRecords(): void {
    this.packed = true
    const rows = this.rows
    if (rows === null) return
    const texts = this.document.texts
    for (let row = 0; row < this.count * PREPARED_ROW_WORDS; row += PREPARED_ROW_WORDS) {
      const surface = rows[row + 1]
      this.addRecord(texts[rows[row]], rows[row + 2], surface === ABSENT_TEXT ? undefined : texts[surface])
    }
  }

  private addRecord(token: string, position: number, surface: string | undefined): void {
    const at = this.used
    this.reserve(at + TOKEN_WORDS)
    const termOffset = this.offsetOf(token)
    const surfaceOffset = surface === undefined ? ABSENT_TEXT : this.offsetOf(surface)
    const records = this.records
    records[at] = position
    records[at + 1] = termOffset
    records[at + 2] = token.length
    records[at + 3] = surfaceOffset
    records[at + 4] = surface?.length ?? 0
    records[at + 7] = ABSENT_TEXT
    this.used += TOKEN_WORDS
  }

  private joinedUnits(): Uint16Array {
    const first = this.pieces[0]
    if (this.pieces.length === 1 && first !== undefined && typeof first !== 'string') return first
    const units = new Uint16Array(this.units)
    let start = 0
    for (const piece of this.pieces) {
      if (typeof piece === 'string') {
        for (let at = 0; at < piece.length; at++) units[start + at] = piece.charCodeAt(at)
      } else units.set(piece, start)
      start += piece.length
    }
    return units
  }

  private reserve(needed: number): void {
    if (needed <= this.records.length) return
    const records = new Uint32Array(
      Math.max(needed, this.records.length * PREPARED_TOKEN_GROWTH_FACTOR, PREPARED_TOKEN_START_CAPACITY * TOKEN_WORDS),
    )
    records.set(this.records)
    this.records = records
  }

  private offsetOf(text: string): number {
    const offsets = this.offsets ?? new Map<string, number>()
    this.offsets = offsets
    const found = offsets.get(text)
    if (found !== undefined) return found
    const offset = this.units
    offsets.set(text, offset)
    this.pieces.push(text)
    this.units += text.length
    return offset
  }
}
