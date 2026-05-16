import type { NumericIndexEntry } from '../../types/internal'
import { bitsetSet, createBitSet } from '../bitset'

function lowerBound(entries: NumericIndexEntry[], value: number): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].value < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(entries: NumericIndexEntry[], value: number): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].value <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function collectDocIds(entries: NumericIndexEntry[], from: number, to: number): Set<number> {
  const result = new Set<number>()
  for (let i = from; i < to; i++) {
    result.add(entries[i].docId)
  }
  return result
}

function collectDocIdsBitset(entries: NumericIndexEntry[], from: number, to: number, capacity: number): Uint32Array {
  const bs = createBitSet(capacity)
  for (let i = from; i < to; i++) {
    bitsetSet(bs, entries[i].docId)
  }
  return bs
}

export interface NumericFieldIndex {
  insert(internalId: number, value: number): void
  remove(internalId: number, value: number): void
  queryEq(value: number): Set<number>
  queryNe(value: number): Set<number>
  queryGt(value: number): Set<number>
  queryGte(value: number): Set<number>
  queryLt(value: number): Set<number>
  queryLte(value: number): Set<number>
  queryBetween(min: number, max: number): Set<number>
  getAllDocIds(): Set<number>
  queryEqBitset(value: number, capacity: number): Uint32Array
  queryGtBitset(value: number, capacity: number): Uint32Array
  queryGteBitset(value: number, capacity: number): Uint32Array
  queryLtBitset(value: number, capacity: number): Uint32Array
  queryLteBitset(value: number, capacity: number): Uint32Array
  queryBetweenBitset(min: number, max: number, capacity: number): Uint32Array
  getAllDocIdsBitset(capacity: number): Uint32Array
  count(): number
  clear(): void
  serialize(): NumericIndexEntry[]
  deserialize(data: NumericIndexEntry[]): void
}

export function createNumericIndex(): NumericFieldIndex {
  let entries: NumericIndexEntry[] = []
  let sorted = true

  function ensureSorted(): void {
    if (!sorted) {
      entries.sort((a, b) => a.value - b.value)
      sorted = true
    }
  }

  return {
    insert(internalId: number, value: number): void {
      entries.push({ value, docId: internalId })
      sorted = false
    },

    remove(internalId: number, value: number): void {
      ensureSorted()
      const start = lowerBound(entries, value)
      const end = upperBound(entries, value)
      for (let i = start; i < end; i++) {
        if (entries[i].docId === internalId) {
          entries.splice(i, 1)
          return
        }
      }
    },

    queryEq(value: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, lowerBound(entries, value), upperBound(entries, value))
    },

    queryNe(value: number): Set<number> {
      ensureSorted()
      const excluded = this.queryEq(value)
      const result = new Set<number>()
      for (const entry of entries) {
        if (!excluded.has(entry.docId)) result.add(entry.docId)
      }
      return result
    },

    queryGt(value: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, upperBound(entries, value), entries.length)
    },

    queryGte(value: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, lowerBound(entries, value), entries.length)
    },

    queryLt(value: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, 0, lowerBound(entries, value))
    },

    queryLte(value: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, 0, upperBound(entries, value))
    },

    queryBetween(min: number, max: number): Set<number> {
      ensureSorted()
      return collectDocIds(entries, lowerBound(entries, min), upperBound(entries, max))
    },

    getAllDocIds(): Set<number> {
      return collectDocIds(entries, 0, entries.length)
    },

    queryEqBitset(value: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, lowerBound(entries, value), upperBound(entries, value), capacity)
    },

    queryGtBitset(value: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, upperBound(entries, value), entries.length, capacity)
    },

    queryGteBitset(value: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, lowerBound(entries, value), entries.length, capacity)
    },

    queryLtBitset(value: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, 0, lowerBound(entries, value), capacity)
    },

    queryLteBitset(value: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, 0, upperBound(entries, value), capacity)
    },

    queryBetweenBitset(min: number, max: number, capacity: number): Uint32Array {
      ensureSorted()
      return collectDocIdsBitset(entries, lowerBound(entries, min), upperBound(entries, max), capacity)
    },

    getAllDocIdsBitset(capacity: number): Uint32Array {
      return collectDocIdsBitset(entries, 0, entries.length, capacity)
    },

    count(): number {
      return entries.length
    },

    clear(): void {
      entries = []
      sorted = true
    },

    serialize(): NumericIndexEntry[] {
      ensureSorted()
      return entries.slice()
    },

    deserialize(data: NumericIndexEntry[]): void {
      entries = data.slice()
      sorted = true
    },
  }
}
