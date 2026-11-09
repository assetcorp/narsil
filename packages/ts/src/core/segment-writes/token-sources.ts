import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { holdsUnpairedSurrogate } from '../ordering/code-points'
import { storedText } from '../stored-values/text'
import { PREPARED_ROW_WORDS, type PreparedSegmentField, packedTokens } from './prepared-tokens'
import { checkText, type SegmentReach } from './regions'
import { requireSegment } from './status'

const RECORD_WORDS = 8
const TERM_WORD = 1
const SURFACE_WORD = 3
const ABSENT_TEXT = 0xffffffff

export interface TokenSource {
  readonly field: number
  readonly records: number
  readonly keys: number
  readonly keyScope: object
  readonly textKeys: boolean
  term(record: number): string
  surface(record: number): string | undefined
  position(record: number): number
  termKey(record: number): number
  surfaceKey(record: number): number
}

export class RecordSource implements TokenSource {
  readonly field: number
  readonly records: number
  readonly keys: number
  readonly keyScope: object = this
  readonly textKeys = false
  private readonly decoded = new Map<number, string>()

  constructor(private readonly source: NativeFieldTokens) {
    this.field = source.field
    this.records = source.tokens.length / RECORD_WORDS
    this.keys = source.units.length + 1
  }

  term(record: number): string {
    return this.text(record * RECORD_WORDS, TERM_WORD)
  }

  surface(record: number): string | undefined {
    const at = record * RECORD_WORDS
    if (this.source.tokens[at + 3] === ABSENT_TEXT || this.source.tokens[at + 4] === 0) return undefined
    return this.text(at, SURFACE_WORD)
  }

  position(record: number): number {
    return this.source.tokens[record * RECORD_WORDS]
  }

  termKey(record: number): number {
    return this.source.tokens[record * RECORD_WORDS + TERM_WORD]
  }

  surfaceKey(record: number): number {
    return this.source.tokens[record * RECORD_WORDS + SURFACE_WORD]
  }

  private text(at: number, word: number): string {
    const tokens = this.source.tokens
    const start = tokens[at + word]
    const length = tokens[at + word + 1]
    const held = this.decoded.get(start)
    if (held !== undefined && held.length === length) return held
    const text = storedText(this.source.units, start, length)
    this.decoded.set(start, text)
    return text
  }
}

export class PreparedSource implements TokenSource {
  readonly field: number
  readonly records: number
  readonly keys: number
  readonly keyScope: object
  readonly textKeys = true
  readonly texts: readonly string[]
  readonly rows: Uint32Array

  constructor(prepared: PreparedSegmentField, texts: readonly string[]) {
    const text = prepared.text
    this.field = prepared.field
    this.records = text.count
    this.keys = texts.length
    this.keyScope = texts
    this.texts = texts
    this.rows = text.rows
  }

  term(record: number): string {
    return this.texts[this.rows[record * PREPARED_ROW_WORDS]]
  }

  surface(record: number): string | undefined {
    const id = this.rows[record * PREPARED_ROW_WORDS + 1]
    if (id === ABSENT_TEXT) return undefined
    const text = this.texts[id]
    return text.length === 0 ? undefined : text
  }

  position(record: number): number {
    return this.rows[record * PREPARED_ROW_WORDS + 2]
  }

  termKey(record: number): number {
    return this.rows[record * PREPARED_ROW_WORDS]
  }

  surfaceKey(record: number): number {
    return this.rows[record * PREPARED_ROW_WORDS + 1]
  }
}

export function preparedRemovalReach(fields: readonly PreparedSegmentField[]): SegmentReach {
  let surfaces = false
  for (const { text } of fields) {
    const end = text.count * PREPARED_ROW_WORDS
    for (let row = 0; row < end && !surfaces; row += PREPARED_ROW_WORDS)
      surfaces = text.rows[row + 1] !== ABSENT_TEXT && text.rows[row + 1] !== text.rows[row]
  }
  return { surfaces, spellings: partialFields => fields.some(({ field }) => partialFields[field] !== 0) }
}

export function preparedSources(fields: readonly PreparedSegmentField[]): TokenSource[] {
  let checked: readonly string[] | null = null
  return fields.map(field => {
    const texts = field.text.texts
    if (texts !== null) {
      if (texts !== checked) for (const held of texts) requireSegment(!holdsUnpairedSurrogate(held))
      checked = texts
      return new PreparedSource(field, texts)
    }
    const packed = packedTokens(field.text)
    const { tokens, units } = packed
    requireSegment(tokens.length % RECORD_WORDS === 0)
    for (let at = 0; at < tokens.length; at += RECORD_WORDS) {
      checkText(units, tokens[at + TERM_WORD], tokens[at + TERM_WORD + 1])
      if (tokens[at + SURFACE_WORD] !== ABSENT_TEXT)
        checkText(units, tokens[at + SURFACE_WORD], tokens[at + SURFACE_WORD + 1])
    }
    return new RecordSource({ field: field.field, ...packed })
  })
}
