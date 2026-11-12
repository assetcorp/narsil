export type DocumentTableVisit = (table: string, entries: number, followsRemoves: boolean) => void

export interface ShardEntryRange {
  shards: number
  smallest: number
  largest: number
}

export interface DocIdMap<V> extends Iterable<[string, V]> {
  readonly size: number
  get(docId: string): V | undefined
  has(docId: string): boolean
  set(docId: string, value: V): unknown
  delete(docId: string): boolean
  clear(): void
  keys(): Iterable<string>
  values(): Iterable<V>
}

export interface DocIdSet extends Iterable<string> {
  readonly size: number
  has(docId: string): boolean
  add(docId: string): unknown
  delete(docId: string): boolean
  clear(): void
}
