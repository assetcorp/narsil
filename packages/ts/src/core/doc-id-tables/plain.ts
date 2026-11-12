import type { DocIdMap, ShardEntryRange } from './types'

export function createDocIdMap<V>(): DocIdMap<V> {
  return new Map<string, V>()
}

export function shardEntryRangeOf(entries: number): ShardEntryRange {
  return { shards: 1, smallest: entries, largest: entries }
}
