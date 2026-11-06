import type { FrozenSegment } from '../partition/frozen'
import type { PartitionReadState } from '../partition/read-state'
import type { KeywordPostingPool } from './request'

export interface SegmentStorage {
  readonly pool: KeywordPostingPool | null
  readonly removed: Uint32Array
}

interface TombstoneBits {
  bits: Uint32Array
  read: number
}

type Tombstones = FrozenSegment['tombstones']

const bitsByTombstones = new WeakMap<Tombstones, TombstoneBits>()

function isFrozenSegment(state: PartitionReadState): state is FrozenSegment {
  return 'tombstones' in state && 'arrays' in state && 'paged' in state
}

function tombstoneBits(tombstones: Tombstones): Uint32Array {
  let held = bitsByTombstones.get(tombstones)
  if (held === undefined) {
    held = { bits: new Uint32Array(0), read: 0 }
    bitsByTombstones.set(tombstones, held)
  }
  for (; held.read < tombstones.size; held.read++) {
    const ordinal = tombstones.at(held.read)
    const word = ordinal >>> 5
    if (word >= held.bits.length) {
      const grown = new Uint32Array(Math.max(word + 1, held.bits.length * 2))
      grown.set(held.bits)
      held.bits = grown
    }
    held.bits[word] |= 1 << (ordinal & 31)
  }
  return held.bits
}

export function segmentStorageOf(state: PartitionReadState): SegmentStorage | null {
  if (isFrozenSegment(state)) {
    const { arrays } = state
    const pool =
      state.paged === null
        ? { docIds: arrays.postingDocIds, frequencies: arrays.postingFrequencies, fields: arrays.postingFieldIndices }
        : null
    return { pool, removed: tombstoneBits(state.tombstones) }
  }
  const postings = state.invertedIdx.livePostings
  if (postings === undefined) return null
  const { pool } = postings
  return {
    pool: { docIds: pool.docIds, frequencies: pool.frequencies, fields: pool.fieldIndices },
    removed: postings.retired,
  }
}
