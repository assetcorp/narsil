import {
  documentFrequency,
  findOwnedTerm,
  lookupExact,
  lookupExactBatch,
  lookupPrefix,
  lookupTypo,
} from '#platform/term-lookups'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeTermDictionary } from '../../vector/native/types/terms'
import { TERM_REGION_GROWTH_FACTOR } from './constants'

const ABSENT_TERM = 0xffffffff

function checked(status: number): number {
  if (status < 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The term dictionary refused a lookup', { status: -status })
  return status
}

export class TermLookup {
  private readonly single = new Uint32Array(1)
  private results = new Uint32Array(0)
  private units = new Uint16Array(0)
  private offsets = new Uint32Array(0)

  find(dictionary: NativeTermDictionary, text: string): number | undefined {
    const owned = findOwnedTerm(dictionary, text)
    if (owned !== null) return owned
    const count = checked(lookupExact(dictionary, this.encode(text), this.single))
    return count === 0 ? undefined : this.single[0]
  }

  findMany(dictionary: NativeTermDictionary, texts: readonly string[]): Uint32Array {
    const first = texts.length === 0 ? null : findOwnedTerm(dictionary, texts[0])
    if (first !== null) {
      this.reserve(texts.length)
      this.results[0] = first ?? ABSENT_TERM
      for (let at = 1; at < texts.length; at++) this.results[at] = findOwnedTerm(dictionary, texts[at]) ?? ABSENT_TERM
      return this.results.subarray(0, texts.length)
    }
    let length = 0
    for (const text of texts) length += text.length
    this.reserveText(length)
    if (texts.length + 1 > this.offsets.length)
      this.offsets = new Uint32Array(Math.max(texts.length + 1, this.offsets.length * TERM_REGION_GROWTH_FACTOR))
    this.reserve(texts.length)
    let offset = 0
    this.offsets[0] = 0
    for (let at = 0; at < texts.length; at++) {
      const text = texts[at]
      for (let unit = 0; unit < text.length; unit++) this.units[offset++] = text.charCodeAt(unit)
      this.offsets[at + 1] = offset
    }
    const count = checked(
      lookupExactBatch(
        dictionary,
        this.units.subarray(0, length),
        this.offsets.subarray(0, texts.length + 1),
        this.results,
      ),
    )
    return this.results.subarray(0, count)
  }

  frequency(dictionary: NativeTermDictionary, ordinal: number): number {
    checked(documentFrequency(dictionary, ordinal, this.single))
    return this.single[0]
  }

  prefix(dictionary: NativeTermDictionary, text: string, limit: number): Uint32Array {
    const count = dictionary.growing?.header[0] ?? dictionary.frequencies.length
    const boundedLimit = Math.min(limit, count)
    this.reserve(boundedLimit)
    const found = checked(lookupPrefix(dictionary, this.encode(text), boundedLimit, this.results))
    return this.results.subarray(0, found)
  }

  typo(dictionary: NativeTermDictionary, text: string, tolerance: number, prefixLength: number): Uint32Array {
    if (tolerance === 0) {
      const found = checked(lookupExact(dictionary, this.encode(text), this.single))
      return this.single.subarray(0, found)
    }
    const count = dictionary.growing?.header[0] ?? dictionary.frequencies.length
    this.reserve(count)
    const found = checked(lookupTypo(dictionary, this.encode(text), tolerance, prefixLength, this.results))
    return this.results.subarray(0, found)
  }

  private encode(text: string): Uint16Array {
    this.reserveText(text.length)
    for (let at = 0; at < text.length; at++) this.units[at] = text.charCodeAt(at)
    return this.units.subarray(0, text.length)
  }

  private reserveText(length: number): void {
    if (length > this.units.length)
      this.units = new Uint16Array(Math.max(length, this.units.length * TERM_REGION_GROWTH_FACTOR))
  }

  private reserve(count: number): void {
    if (count > this.results.length)
      this.results = new Uint32Array(Math.max(count, this.results.length * TERM_REGION_GROWTH_FACTOR))
  }
}
