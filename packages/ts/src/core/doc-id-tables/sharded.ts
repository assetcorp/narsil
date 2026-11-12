import { FNV_OFFSET_BASIS, FNV_PRIME } from '../hash'
import {
  DOC_ID_TABLE_SHARD_BITS,
  DOC_ID_TABLE_SHARD_SKEW_DEVIATIONS,
  DOC_ID_TABLE_SHARD_SKEW_ENTRIES,
} from './constants'
import type { DocIdMap, ShardEntryRange } from './types'

const SHARD_COUNT = 1 << DOC_ID_TABLE_SHARD_BITS
const SHARD_MASK = SHARD_COUNT - 1

function shardOf(docId: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < docId.length; i++) hash = Math.imul(hash ^ docId.charCodeAt(i), FNV_PRIME)
  hash >>>= 0
  return ((hash >>> DOC_ID_TABLE_SHARD_BITS) ^ hash) & SHARD_MASK
}

class ShardedDocIdMap<V> implements DocIdMap<V> {
  private readonly shards = Array.from({ length: SHARD_COUNT }, () => new Map<string, V>())
  private count = 0

  get size(): number {
    return this.count
  }

  get(docId: string): V | undefined {
    return this.shards[shardOf(docId)].get(docId)
  }

  has(docId: string): boolean {
    return this.shards[shardOf(docId)].has(docId)
  }

  set(docId: string, value: V): this {
    const shard = this.shards[shardOf(docId)]
    const before = shard.size
    shard.set(docId, value)
    this.count += shard.size - before
    return this
  }

  delete(docId: string): boolean {
    if (!this.shards[shardOf(docId)].delete(docId)) return false
    this.count -= 1
    return true
  }

  clear(): void {
    for (const shard of this.shards) shard.clear()
    this.count = 0
  }

  *keys(): IterableIterator<string> {
    for (const shard of this.shards) yield* shard.keys()
  }

  *values(): IterableIterator<V> {
    for (const shard of this.shards) yield* shard.values()
  }

  *[Symbol.iterator](): IterableIterator<[string, V]> {
    for (const shard of this.shards) yield* shard
  }
}

export function createDocIdMap<V>(): DocIdMap<V> {
  return new ShardedDocIdMap<V>()
}

export function shardEntryRangeOf(entries: number): ShardEntryRange {
  const mean = entries / SHARD_COUNT
  const skew = DOC_ID_TABLE_SHARD_SKEW_DEVIATIONS * Math.sqrt(mean) + DOC_ID_TABLE_SHARD_SKEW_ENTRIES
  return {
    shards: SHARD_COUNT,
    smallest: Math.max(0, Math.floor(mean - skew)),
    largest: Math.min(entries, Math.ceil(mean + skew)),
  }
}
