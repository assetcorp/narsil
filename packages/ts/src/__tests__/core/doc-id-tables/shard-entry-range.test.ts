import { describe, expect, it } from 'vitest'
import { createDocIdMap, shardEntryRangeOf } from '../../../core/doc-id-tables/sharded'

const ORACLE_SHARD_BITS = 6n
const ORACLE_SHARDS = 64
const FNV1A_32_OFFSET = 2_166_136_261n
const FNV1A_32_PRIME = 16_777_619n
const WORD = 0xffff_ffffn
const TABLE_SIZES = [65_536, 131_072]
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function oracleShardOf(docId: string): number {
  let hash = FNV1A_32_OFFSET
  for (const unit of Array.from({ length: docId.length }, (_, at) => BigInt(docId.charCodeAt(at)))) {
    hash = ((hash ^ unit) * FNV1A_32_PRIME) & WORD
  }
  return Number(((hash >> ORACLE_SHARD_BITS) ^ hash) & BigInt(ORACLE_SHARDS - 1))
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

function hexDigits(random: () => number, count: number): string {
  let text = ''
  for (let digit = 0; digit < count; digit++) text += Math.floor(random() * 16).toString(16)
  return text
}

function uuidOf(random: () => number): string {
  return `${hexDigits(random, 8)}-${hexDigits(random, 4)}-4${hexDigits(random, 3)}-a${hexDigits(random, 3)}-${hexDigits(random, 12)}`
}

function ulidOf(serial: number, random: () => number): string {
  let time = 1_700_000_000_000 + serial
  let text = ''
  for (let place = 0; place < 10; place++) {
    text = CROCKFORD[time % 32] + text
    time = Math.floor(time / 32)
  }
  for (let place = 0; place < 16; place++) text += CROCKFORD[Math.floor(random() * 32)]
  return text
}

const ID_SHAPES: Record<string, (serial: number, random: () => number) => string> = {
  uuid: (_, random) => uuidOf(random),
  numeric: serial => String(serial),
  prefixed: serial => `doc-${serial}`,
  padded: serial => `item-${String(serial).padStart(8, '0')}`,
  tenantOrder: serial => `tenant-${serial % 37}:order:${Math.floor(serial / 37)}`,
  ulid: ulidOf,
  sku: serial => `SKU${String(serial % 1_000).padStart(3, '0')}-${Math.floor(serial / 1_000)}`,
  email: serial => `user${serial}@example.com`,
}

interface ShardSizes {
  smallest: number
  largest: number
}

function realShardSizes(docIds: readonly string[]): ShardSizes {
  const table = createDocIdMap<true>()
  for (const docId of docIds) table.set(docId, true)
  const sizes = new Array<number>(ORACLE_SHARDS).fill(0)
  let previousShard = 0
  let misplaced: string | null = null
  for (const docId of table.keys()) {
    const shard = oracleShardOf(docId)
    if (shard < previousShard) misplaced ??= docId
    previousShard = shard
    sizes[shard]++
  }
  expect(misplaced, 'the table keeps an ID in a shard the oracle does not predict').toBeNull()
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(docIds.length)
  return { smallest: Math.min(...sizes), largest: Math.max(...sizes) }
}

describe('the entry range of a sharded document table', () => {
  for (const [shape, idOf] of Object.entries(ID_SHAPES)) {
    for (const size of TABLE_SIZES) {
      it(`covers the smallest and largest shard of ${size.toLocaleString('en-GB')} ${shape} IDs`, () => {
        const random = createRandom(size ^ shape.length)
        const docIds = Array.from({ length: size }, (_, serial) => idOf(serial, random))
        const real = realShardSizes(docIds)
        const range = shardEntryRangeOf(size)
        expect(range.shards).toBe(ORACLE_SHARDS)
        expect(range.largest, `the largest shard holds ${real.largest}`).toBeGreaterThanOrEqual(real.largest)
        expect(range.smallest, `the smallest shard holds ${real.smallest}`).toBeLessThanOrEqual(real.smallest)
      })
    }
  }
})
