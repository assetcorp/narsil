import type { NativeTermDictionary } from '../../vector/native/types/terms'
import { storedText } from '../stored-values/text'
import { TermTable } from '../term-table'
import { NO_SLICE } from './pools'

export const TERM_LIVE = 1
export const TERM_ORDERED = 2
export const TERM_POSITIONS = 4

const EMPTY_TOKEN_BYTES = new Uint8Array(0)
const EMPTY_TOKEN_OFFSETS = new Uint32Array(0)

function grow<T extends Uint32Array | Uint8Array | Float64Array>(source: T, target: T): T {
  target.set(source)
  return target
}

export class TermColumns {
  ids: TermTable
  tokens: string[] = []
  sliceStart: Uint32Array
  sliceClass: Uint8Array
  lengths: Uint32Array
  docFrequency: Uint32Array
  deadDocuments: Uint32Array
  totalTermFrequency: Float64Array
  surfaceOccurrences: Float64Array
  revision: Uint32Array
  flags: Uint8Array
  count = 0
  liveCount = 0
  nonemptyCount = 0
  nonemptyStale = false
  generation = 0
  tokenCodeUnits = 0

  constructor(private readonly startCapacity: number) {
    this.ids = new TermTable(startCapacity)
    this.sliceStart = new Uint32Array(startCapacity)
    this.sliceClass = new Uint8Array(startCapacity)
    this.lengths = new Uint32Array(startCapacity)
    this.docFrequency = new Uint32Array(startCapacity)
    this.deadDocuments = new Uint32Array(startCapacity)
    this.totalTermFrequency = new Float64Array(startCapacity)
    this.surfaceOccurrences = new Float64Array(startCapacity)
    this.revision = new Uint32Array(startCapacity)
    this.flags = new Uint8Array(startCapacity)
  }

  dictionary(): NativeTermDictionary {
    return {
      growing: this.ids,
      tokens: EMPTY_TOKEN_BYTES,
      offsets: EMPTY_TOKEN_OFFSETS,
      frequencies: this.docFrequency,
      removed: this.deadDocuments,
    }
  }

  add(token: string): number {
    const ordinal = this.count
    if (ordinal === this.flags.length) this.growTo(ordinal * 2)
    this.ids.set(token, ordinal)
    this.tokens.push(token)
    this.count = ordinal + 1
    this.liveCount++
    this.nonemptyCount++
    this.tokenCodeUnits += token.length
    this.sliceClass[ordinal] = NO_SLICE
    this.flags[ordinal] = TERM_LIVE | TERM_ORDERED
    return ordinal
  }

  reserve(terms: number, units: number): void {
    const prepared = this.ids.prepareCapacity(terms, units)
    if (prepared.capacity > this.flags.length) this.growTo(prepared.capacity)
    prepared.apply()
  }

  nonemptyTerms(): number {
    if (this.nonemptyStale) {
      let nonempty = 0
      for (let ordinal = 0; ordinal < this.count; ordinal++) {
        if (this.isLive(ordinal) && this.frequencyAt(ordinal) > 0) nonempty++
      }
      this.nonemptyCount = nonempty
      this.nonemptyStale = false
    }
    return this.nonemptyCount
  }

  acceptPublication(nonemptyChange: number | null): void {
    const count = this.ids.header[0]
    if (this.generation !== this.ids.header[3]) {
      const tokens = new Array<string>(count)
      let units = 0
      let nonempty = 0
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const length = this.ids.termLength[ordinal]
        tokens[ordinal] = storedText(this.ids.units, this.ids.termOffset[ordinal], length)
        units += length
        if (this.frequencyAt(ordinal) > 0) nonempty++
      }
      this.tokens = tokens
      this.count = count
      this.liveCount = this.ids.header[1]
      this.nonemptyCount = nonempty
      this.nonemptyStale = false
      this.tokenCodeUnits = units
      this.generation = this.ids.header[3]
      this.ids.acceptCompaction()
      return
    }
    for (let ordinal = this.count; ordinal < count; ordinal++) {
      const length = this.ids.termLength[ordinal]
      this.tokens.push(storedText(this.ids.units, this.ids.termOffset[ordinal], length))
      this.tokenCodeUnits += length
    }
    this.count = count
    this.liveCount = this.ids.header[1]
    if (nonemptyChange === null) this.nonemptyStale = true
    else this.nonemptyCount += nonemptyChange
  }

  isLive(ordinal: number): boolean {
    return (this.flags[ordinal] & TERM_LIVE) !== 0
  }

  frequencyAt(ordinal: number): number {
    return this.docFrequency[ordinal] - this.deadDocuments[ordinal]
  }

  clear(): void {
    this.ids = new TermTable(this.startCapacity)
    this.tokens = []
    this.count = 0
    this.liveCount = 0
    this.nonemptyCount = 0
    this.nonemptyStale = false
    this.tokenCodeUnits = 0
    this.generation++
    this.ids.setGeneration(this.generation)
    this.sliceStart = new Uint32Array(this.startCapacity)
    this.sliceClass = new Uint8Array(this.startCapacity)
    this.lengths = new Uint32Array(this.startCapacity)
    this.docFrequency = new Uint32Array(this.startCapacity)
    this.deadDocuments = new Uint32Array(this.startCapacity)
    this.totalTermFrequency = new Float64Array(this.startCapacity)
    this.surfaceOccurrences = new Float64Array(this.startCapacity)
    this.revision = new Uint32Array(this.startCapacity)
    this.flags = new Uint8Array(this.startCapacity)
  }

  byteLength(): number {
    return (
      this.sliceStart.byteLength +
      this.sliceClass.byteLength +
      this.lengths.byteLength +
      this.docFrequency.byteLength +
      this.deadDocuments.byteLength +
      this.totalTermFrequency.byteLength +
      this.surfaceOccurrences.byteLength +
      this.revision.byteLength +
      this.flags.byteLength +
      this.ids.byteLength()
    )
  }

  private growTo(capacity: number): void {
    const columns = {
      sliceStart: grow(this.sliceStart, new Uint32Array(capacity)),
      sliceClass: grow(this.sliceClass, new Uint8Array(capacity)),
      lengths: grow(this.lengths, new Uint32Array(capacity)),
      docFrequency: grow(this.docFrequency, new Uint32Array(capacity)),
      deadDocuments: grow(this.deadDocuments, new Uint32Array(capacity)),
      totalTermFrequency: grow(this.totalTermFrequency, new Float64Array(capacity)),
      surfaceOccurrences: grow(this.surfaceOccurrences, new Float64Array(capacity)),
      revision: grow(this.revision, new Uint32Array(capacity)),
      flags: grow(this.flags, new Uint8Array(capacity)),
    }
    Object.assign(this, columns)
  }
}
