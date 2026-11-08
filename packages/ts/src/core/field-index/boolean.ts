import { countBooleanFacet } from '../../search/facets'
import { bitsetClear, bitsetHas, bitsetSet } from '../bitset'
import { FieldPresence } from './presence'

export interface BooleanFieldIndexReader {
  regionBytes(): number
  regions(capacity: number): { trueBits: Uint32Array; falseBits: Uint32Array }
  getAllDocIdsBitset(capacity: number): Uint32Array
  count(): number
  serialize(): { trueDocs: number[]; falseDocs: number[] }
  facetCounts(matched: Uint32Array): { trueCount: number; falseCount: number }
}

export interface BooleanFieldIndex extends BooleanFieldIndexReader {
  insert(internalId: number, value: boolean): void
  remove(internalId: number, value: boolean): void
  clear(): void
  deserialize(data: { trueDocs: number[]; falseDocs: number[] }): void
}

export function createBooleanIndex(): BooleanFieldIndex {
  let trueBits = new Uint32Array(1)
  let falseBits = new Uint32Array(1)
  let trueCount = 0
  let falseCount = 0
  const present = new FieldPresence(function* () {
    yield* ordinals(trueBits)
    yield* ordinals(falseBits)
  })

  function grow(ordinal: number): void {
    const words = (ordinal >>> 5) + 1
    if (words <= trueBits.length) return
    const nextTrue = new Uint32Array(Math.max(words, trueBits.length * 2))
    const nextFalse = new Uint32Array(nextTrue.length)
    nextTrue.set(trueBits)
    nextFalse.set(falseBits)
    trueBits = nextTrue
    falseBits = nextFalse
  }

  function* ordinals(bits: Uint32Array): Generator<number> {
    for (let at = 0; at < bits.length; at++) {
      let word = bits[at]
      while (word !== 0) {
        yield at * 32 + (31 - Math.clz32(word & -word))
        word &= word - 1
      }
    }
  }

  function insert(ordinal: number, value: boolean): void {
    grow(ordinal)
    const bits = value ? trueBits : falseBits
    if (bitsetHas(bits, ordinal)) return
    present.invalidate()
    bitsetSet(bits, ordinal)
    if (value) trueCount++
    else falseCount++
  }

  function clear(): void {
    present.invalidate()
    trueBits = new Uint32Array(1)
    falseBits = new Uint32Array(1)
    trueCount = 0
    falseCount = 0
  }

  return {
    regionBytes: () => trueBits.byteLength + falseBits.byteLength + present.bytes(),
    regions() {
      return { trueBits, falseBits }
    },

    insert,

    remove(internalId: number, value: boolean): void {
      const bits = value ? trueBits : falseBits
      if (!bitsetHas(bits, internalId)) return
      present.invalidate()
      bitsetClear(bits, internalId)
      if (value) trueCount--
      else falseCount--
    },

    getAllDocIdsBitset(capacity: number): Uint32Array {
      return present.regions(capacity)
    },

    count(): number {
      return trueCount + falseCount
    },

    facetCounts(matched: Uint32Array): { trueCount: number; falseCount: number } {
      return countBooleanFacet(trueBits, falseBits, matched)
    },

    clear,

    serialize(): { trueDocs: number[]; falseDocs: number[] } {
      return {
        trueDocs: Array.from(ordinals(trueBits)),
        falseDocs: Array.from(ordinals(falseBits)),
      }
    },

    deserialize(data: { trueDocs: number[]; falseDocs: number[] }): void {
      clear()
      for (const id of data.trueDocs) insert(id, true)
      for (const id of data.falseDocs) insert(id, false)
    },
  }
}
