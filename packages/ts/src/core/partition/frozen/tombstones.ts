import { ErrorCodes, NarsilError } from '../../../errors'
import { TOMBSTONE_ARRIVAL_BYTES } from './constants'

export interface FrozenTombstones {
  readonly bits: Uint32Array
  readonly count: Uint32Array
  readonly size: number
  readonly revision: number
  has(internalId: number): boolean
  prepare(internalId: number): () => boolean
  add(internalId: number): boolean
  at(arrival: number): number
  values(): IterableIterator<number>
  bytes(): number
}

const WORD_BITS = 32
const UINT32_MAX = 0xffffffff

export function createFrozenTombstones(capacity: number): FrozenTombstones {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > UINT32_MAX)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The frozen document capacity is invalid')
  const bits = new Uint32Array(Math.max(1, Math.ceil(capacity / WORD_BITS)))
  const count = new Uint32Array(1)
  const arrivals: number[] = []

  function has(ordinal: number): boolean {
    return (
      count[0] > 0 &&
      ordinal >= 0 &&
      ordinal < capacity &&
      Number.isInteger(ordinal) &&
      (bits[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0
    )
  }

  function prepare(internalId: number): () => boolean {
    if (!Number.isInteger(internalId) || internalId < 0 || internalId >= capacity)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'A removed document leaves its frozen segment')
    const arrival = count[0]
    if (has(internalId)) return () => false
    arrivals[arrival] = internalId
    return () => {
      if (has(internalId)) return false
      if (count[0] !== arrival)
        throw new NarsilError(
          ErrorCodes.PARTITION_CORRUPTED,
          'The frozen removal publication changed during preparation',
        )
      arrivals[arrival] = internalId
      bits[internalId >>> 5] |= 1 << (internalId & 31)
      count[0]++
      return true
    }
  }

  return {
    bits,
    count,
    get size() {
      return count[0]
    },
    get revision() {
      return count[0]
    },
    has,
    prepare,
    add(internalId: number): boolean {
      return prepare(internalId)()
    },
    at(arrival: number): number {
      if (!Number.isInteger(arrival) || arrival < 0 || arrival >= count[0])
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'A removal arrival leaves the frozen publication')
      return arrivals[arrival]
    },
    *values(): IterableIterator<number> {
      for (let arrival = 0; arrival < count[0]; arrival++) yield arrivals[arrival]
    },
    bytes(): number {
      return bits.byteLength + count.byteLength + arrivals.length * TOMBSTONE_ARRIVAL_BYTES
    },
  }
}
