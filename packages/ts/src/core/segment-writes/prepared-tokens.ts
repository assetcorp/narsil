import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { PREPARED_TOKEN_GROWTH_FACTOR, PREPARED_TOKEN_START_CAPACITY } from './constants'

const TOKEN_WORDS = 8
const ABSENT_TEXT = 0xffffffff

export class PreparedTokens {
  private records = new Uint32Array(PREPARED_TOKEN_START_CAPACITY * TOKEN_WORDS)
  private used = 0
  private readonly text = new Map<string, number>()
  private units = 0
  private readonly pieces: Array<string | Uint16Array> = []

  add(token: string, position: number, surface: string | undefined): void {
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

  append(tokens: Uint32Array, units: Uint16Array, position: number): void {
    if (tokens.length === 0) return
    this.reserve(this.used + tokens.length)
    this.pieces.push(units.slice())
    this.records.set(tokens, this.used)
    const end = this.used + tokens.length
    for (let at = this.used; at < end; at += TOKEN_WORDS) {
      this.records[at] += position
      this.records[at + 1] += this.units
      if (this.records[at + 3] !== ABSENT_TEXT) this.records[at + 3] += this.units
    }
    this.used = end
    this.units += units.length
  }

  finish(): Pick<NativeFieldTokens, 'tokens' | 'units'> {
    const tokens = this.used === this.records.length ? this.records : this.records.slice(0, this.used)
    const first = this.pieces[0]
    if (this.pieces.length === 1 && first !== undefined && typeof first !== 'string') return { tokens, units: first }
    const units = new Uint16Array(this.units)
    let start = 0
    for (const piece of this.pieces) {
      if (typeof piece === 'string') {
        for (let at = 0; at < piece.length; at++) units[start + at] = piece.charCodeAt(at)
      } else units.set(piece, start)
      start += piece.length
    }
    return { tokens, units }
  }

  private reserve(needed: number): void {
    if (needed <= this.records.length) return
    const records = new Uint32Array(Math.max(needed, this.records.length * PREPARED_TOKEN_GROWTH_FACTOR))
    records.set(this.records)
    this.records = records
  }

  private offsetOf(text: string): number {
    const found = this.text.get(text)
    if (found !== undefined) return found
    const offset = this.units
    this.text.set(text, offset)
    this.pieces.push(text)
    this.units += text.length
    return offset
  }
}
