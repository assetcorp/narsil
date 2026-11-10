import type { RemovedSpellings } from '../partition/frozen/removed-spellings'
import {
  REMOVAL_SCRATCH_GROWTH_FACTOR,
  REMOVAL_SCRATCH_SLOTS_PER_KEY,
  REMOVAL_SCRATCH_START_KEY_UNITS,
  REMOVAL_SCRATCH_START_KEYS,
  REMOVAL_SCRATCH_START_TOKEN_WORDS,
  REMOVAL_SCRATCH_START_UNITS,
} from './constants'

export const NO_SURFACE = 0xffffffff
export const FIELD_TOKEN_WORDS = 8
export const NO_KEY = -1
const ABSENT_TEXT = 0xffffffff
const NO_ENTRY = 0xffffffff
const NO_FIELD = -1
const LISTED_TAG = 0xffff
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function hashText(text: string, tag: number): number {
  let hash = FNV_OFFSET_BASIS
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), FNV_PRIME)
  return Math.imul(hash ^ tag, FNV_PRIME)
}

function hashUnits(units: Uint16Array, start: number, length: number, tag: number): number {
  let hash = FNV_OFFSET_BASIS
  for (let at = start; at < start + length; at++) hash = Math.imul(hash ^ units[at], FNV_PRIME)
  return Math.imul(hash ^ tag, FNV_PRIME)
}

function grownUint32(held: Uint32Array<ArrayBuffer>, used: number, needed: number): Uint32Array<ArrayBuffer> {
  if (needed <= held.length) return held
  const grown = new Uint32Array(Math.max(held.length * REMOVAL_SCRATCH_GROWTH_FACTOR, needed))
  grown.set(held.subarray(0, used))
  return grown
}

function grownUint16(held: Uint16Array, used: number, needed: number): Uint16Array {
  if (needed <= held.length) return held
  const grown = new Uint16Array(Math.max(held.length * REMOVAL_SCRATCH_GROWTH_FACTOR, needed))
  grown.set(held.subarray(0, used))
  return grown
}

export class RemovalScratch {
  tokens = new Uint32Array(REMOVAL_SCRATCH_START_TOKEN_WORDS)
  units: Uint16Array = new Uint16Array(REMOVAL_SCRATCH_START_UNITS)
  tokenWords = 0
  unitCount = 0
  private field = NO_FIELD
  private fieldStart = 0
  private keyCount = 0
  private keyUnits: Uint16Array = new Uint16Array(REMOVAL_SCRATCH_START_KEY_UNITS)
  private keyUnitCount = 0
  private keyStarts = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private keyLengths = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private keyTags = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private keyFields = new Int32Array(REMOVAL_SCRATCH_START_KEYS)
  private termAt = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private surfaceAt = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private listedAt = new Uint32Array(REMOVAL_SCRATCH_START_KEYS)
  private readonly terms: (string | null)[] = []
  private readonly surfaces: (string | null)[] = []
  private readonly listed: string[] = []
  private listedCount = 0
  private readonly listedCounts: number[] = []
  private slots = new Int32Array(REMOVAL_SCRATCH_START_KEYS * REMOVAL_SCRATCH_SLOTS_PER_KEY).fill(NO_KEY)

  reset(): void {
    this.tokenWords = 0
    this.unitCount = 0
    this.field = NO_FIELD
    if (this.keyCount > 0) this.slots.fill(NO_KEY)
    this.keyCount = 0
    this.keyUnitCount = 0
    this.listedCount = 0
  }

  beginField(): void {
    this.field++
    this.fieldStart = this.unitCount
  }

  fieldUnits(): Uint16Array {
    return this.units.subarray(this.fieldStart, this.unitCount)
  }

  private writeText(text: string): number {
    const start = this.unitCount
    this.units = grownUint16(this.units, start, start + text.length)
    const units = this.units
    for (let at = 0; at < text.length; at++) units[start + at] = text.charCodeAt(at)
    this.unitCount = start + text.length
    return start - this.fieldStart
  }

  private sameText(key: number, text: string, tag: number): boolean {
    if (this.keyTags[key] !== tag || this.keyLengths[key] !== text.length) return false
    const start = this.keyStarts[key]
    const units = this.keyUnits
    for (let at = 0; at < text.length; at++) if (units[start + at] !== text.charCodeAt(at)) return false
    return true
  }

  private slotOf(text: string, tag: number): number {
    const slots = this.slots
    const mask = slots.length - 1
    let slot = hashText(text, tag) & mask
    let key = slots[slot]
    while (key !== NO_KEY && !this.sameText(key, text, tag)) {
      slot = (slot + 1) & mask
      key = slots[slot]
    }
    return slot
  }

  find(text: string, tag: number): number {
    return this.slots[this.slotOf(text, tag)]
  }

  private rehash(): void {
    const slots = new Int32Array(this.slots.length * REMOVAL_SCRATCH_GROWTH_FACTOR).fill(NO_KEY)
    const mask = slots.length - 1
    for (let key = 0; key < this.keyCount; key++) {
      let slot = hashUnits(this.keyUnits, this.keyStarts[key], this.keyLengths[key], this.keyTags[key]) & mask
      while (slots[slot] !== NO_KEY) slot = (slot + 1) & mask
      slots[slot] = key
    }
    this.slots = slots
  }

  private growKeys(): void {
    const used = this.keyCount
    const needed = used + 1
    if (needed <= this.keyStarts.length) return
    this.keyStarts = grownUint32(this.keyStarts, used, needed)
    this.keyLengths = grownUint32(this.keyLengths, used, needed)
    this.keyTags = grownUint32(this.keyTags, used, needed)
    this.termAt = grownUint32(this.termAt, used, needed)
    this.surfaceAt = grownUint32(this.surfaceAt, used, needed)
    this.listedAt = grownUint32(this.listedAt, used, needed)
    const fields = new Int32Array(this.keyStarts.length)
    fields.set(this.keyFields.subarray(0, used))
    this.keyFields = fields
  }

  add(text: string, tag: number, term: string | null, surface: string | null): number {
    if ((this.keyCount + 1) * REMOVAL_SCRATCH_SLOTS_PER_KEY > this.slots.length) this.rehash()
    this.growKeys()
    const key = this.keyCount++
    const start = this.keyUnitCount
    this.keyUnits = grownUint16(this.keyUnits, start, start + text.length)
    for (let at = 0; at < text.length; at++) this.keyUnits[start + at] = text.charCodeAt(at)
    this.keyUnitCount = start + text.length
    this.keyStarts[key] = start
    this.keyLengths[key] = text.length
    this.keyTags[key] = tag
    this.keyFields[key] = NO_FIELD
    this.listedAt[key] = NO_ENTRY
    this.terms[key] = term
    this.surfaces[key] = surface
    this.slots[this.slotOf(text, tag)] = key
    return key
  }

  private appendListed(spelling: string): number {
    const entry = this.listedCount++
    this.listedCounts[entry] = 0
    this.listed[entry] = spelling
    return entry
  }

  listSpelling(key: number, spelling: string, shared: boolean): void {
    if (!shared) {
      this.listedAt[key] = this.appendListed(spelling)
      return
    }
    let listing = this.find(spelling, LISTED_TAG)
    if (listing === NO_KEY) {
      listing = this.add(spelling, LISTED_TAG, null, null)
      this.listedAt[listing] = this.appendListed(spelling)
    }
    this.listedAt[key] = this.listedAt[listing]
  }

  countListed(key: number): void {
    const entry = this.listedAt[key]
    if (entry !== NO_ENTRY) this.listedCounts[entry]++
  }

  recordsTokens(key: number): boolean {
    return this.terms[key] !== null
  }

  writeRecord(position: number, key: number): void {
    const term = this.terms[key]
    if (term === null) return
    if (this.keyFields[key] !== this.field) {
      const surface = this.surfaces[key]
      this.termAt[key] = this.writeText(term)
      this.surfaceAt[key] = surface === null ? NO_SURFACE : this.writeText(surface)
      this.keyFields[key] = this.field
    }
    const at = this.tokenWords
    this.tokens = grownUint32(this.tokens, at, at + FIELD_TOKEN_WORDS)
    const tokens = this.tokens
    const surfaceAt = this.surfaceAt[key]
    tokens[at] = position
    tokens[at + 1] = this.termAt[key]
    tokens[at + 2] = term.length
    tokens[at + 3] = surfaceAt
    tokens[at + 4] = surfaceAt === NO_SURFACE ? 0 : (this.surfaces[key]?.length ?? 0)
    tokens[at + 5] = 0
    tokens[at + 6] = 0
    tokens[at + 7] = ABSENT_TEXT
    this.tokenWords = at + FIELD_TOKEN_WORDS
  }

  copyRecord(source: Uint32Array, at: number): void {
    this.tokens = grownUint32(this.tokens, this.tokenWords, this.tokenWords + FIELD_TOKEN_WORDS)
    this.tokens.set(source.subarray(at, at + FIELD_TOKEN_WORDS), this.tokenWords)
    this.tokenWords += FIELD_TOKEN_WORDS
  }

  removedSpellings(): RemovedSpellings {
    const size = this.listedCount
    if (size === 0) return { spellings: [], counts: [] }
    return { spellings: this.listed.slice(0, size), counts: this.listedCounts.slice(0, size) }
  }
}
