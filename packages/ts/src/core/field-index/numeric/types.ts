import type { NumericIndexEntry } from '../../../types/internal'
import type { NumericRegions } from './storage'

export interface NumericFieldIndexReader {
  cachedBytes(): number
  regions(): NumericRegions
  getAllDocIdsBitset(capacity: number): Uint32Array
  count(): number
  serialize(): NumericIndexEntry[]
  facetValueCounts(matched: Uint32Array): Map<number, number>
}

export interface NumericFieldIndex extends NumericFieldIndexReader {
  bytes(): number
  insert(internalId: number, value: number): void
  remove(internalId: number, value: number): void
  sortPending(): void
  clear(): void
  deserialize(data: NumericIndexEntry[]): void
}
