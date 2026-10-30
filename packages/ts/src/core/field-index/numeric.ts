import type { NumericIndexEntry } from '../../types/internal'
import { bitsetHas, bitsetSet, createBitSet } from '../bitset'
import { PENDING_REMOVAL_MERGE_DIVISOR, PENDING_REMOVAL_MERGE_FLOOR } from '../constants'

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

export interface NumericFieldIndexReader {
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
  serialize(): NumericIndexEntry[]
  facetValueCounts(matched: Uint32Array): Map<number, number>
  facetRangeCount(from: number, to: number, matched: Uint32Array): number
}

export interface NumericFieldIndex extends NumericFieldIndexReader {
  insert(internalId: number, value: number): void
  remove(internalId: number, value: number): void
  clear(): void
  deserialize(data: NumericIndexEntry[]): void
}

interface PendingRemovals {
  value: number
  limits: number[]
  next: number
}

function removalsFor(byDocument: Map<number, PendingRemovals[]>, docId: number, value: number) {
  const keys = byDocument.get(docId)
  if (keys === undefined) return undefined
  for (const key of keys) {
    if (key.value === value) return key
  }
  return undefined
}

function groupRemovals(docIds: number[], values: number[], limits: number[]): Map<number, PendingRemovals[]> {
  const byDocument = new Map<number, PendingRemovals[]>()
  for (let at = 0; at < docIds.length; at++) {
    const existing = removalsFor(byDocument, docIds[at], values[at])
    if (existing !== undefined) {
      existing.limits.push(limits[at])
      continue
    }
    const key: PendingRemovals = { value: values[at], limits: [limits[at]], next: 0 }
    const keys = byDocument.get(docIds[at])
    if (keys === undefined) byDocument.set(docIds[at], [key])
    else keys.push(key)
  }
  return byDocument
}

function markedDocuments(docIds: number[]): Uint8Array {
  let highest = 0
  for (const docId of docIds) if (docId > highest) highest = docId
  const marked = new Uint8Array(highest + 1)
  for (const docId of docIds) marked[docId] = 1
  return marked
}

function removeFromSorted(
  entries: NumericIndexEntry[],
  from: number,
  marked: Uint8Array,
  byDocument: Map<number, PendingRemovals[]>,
): void {
  let write = from
  for (let read = from; read < entries.length; read++) {
    const entry = entries[read]
    if (entry.docId < marked.length && marked[entry.docId] === 1) {
      const key = removalsFor(byDocument, entry.docId, entry.value)
      if (key !== undefined && key.next < key.limits.length) {
        key.next++
        continue
      }
    }
    entries[write++] = entry
  }
  entries.length = write
}

function removeFromPending(
  pending: NumericIndexEntry[],
  marked: Uint8Array,
  byDocument: Map<number, PendingRemovals[]>,
): void {
  let write = 0
  for (let read = 0; read < pending.length; read++) {
    const entry = pending[read]
    if (entry.docId < marked.length && marked[entry.docId] === 1) {
      const key = removalsFor(byDocument, entry.docId, entry.value)
      if (key !== undefined) {
        while (key.next < key.limits.length && key.limits[key.next] <= read) key.next++
        if (key.next < key.limits.length) {
          key.next++
          continue
        }
      }
    }
    pending[write++] = entry
  }
  pending.length = write
}

function mergeSortedPending(entries: NumericIndexEntry[], pending: NumericIndexEntry[]): void {
  pending.sort((a, b) => a.value - b.value)
  const mainLength = entries.length
  for (const entry of pending) entries.push(entry)
  let left = mainLength - 1
  let right = pending.length - 1
  let write = entries.length - 1
  while (right >= 0) {
    if (left >= 0 && entries[left].value > pending[right].value) entries[write--] = entries[left--]
    else entries[write--] = pending[right--]
  }
}

export function createNumericIndex(): NumericFieldIndex {
  let entries: NumericIndexEntry[] = []
  let pending: NumericIndexEntry[] = []
  const removedDocIds: number[] = []
  const removedValues: number[] = []
  const removedLimits: number[] = []

  function applyRemovals(): void {
    const byDocument = groupRemovals(removedDocIds, removedValues, removedLimits)
    const marked = markedDocuments(removedDocIds)
    let lowest = removedValues[0]
    for (const value of removedValues) if (value < lowest) lowest = value
    removeFromSorted(entries, lowerBound(entries, lowest), marked, byDocument)
    if (pending.length > 0) removeFromPending(pending, marked, byDocument)
    removedDocIds.length = 0
    removedValues.length = 0
    removedLimits.length = 0
  }

  function ensureSorted(): void {
    if (removedDocIds.length > 0) applyRemovals()
    if (pending.length === 0) return
    if (entries.length === 0) {
      pending.sort((a, b) => a.value - b.value)
      entries = pending
    } else {
      mergeSortedPending(entries, pending)
    }
    pending = []
  }

  function discardPending(): void {
    pending = []
    removedDocIds.length = 0
    removedValues.length = 0
    removedLimits.length = 0
  }

  return {
    insert(internalId: number, value: number): void {
      pending.push({ value, docId: internalId })
    },

    remove(internalId: number, value: number): void {
      removedDocIds.push(internalId)
      removedValues.push(value)
      removedLimits.push(pending.length)
      const held = entries.length + pending.length
      if (removedDocIds.length >= Math.max(PENDING_REMOVAL_MERGE_FLOOR, held / PENDING_REMOVAL_MERGE_DIVISOR)) {
        ensureSorted()
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
      ensureSorted()
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
      ensureSorted()
      return collectDocIdsBitset(entries, 0, entries.length, capacity)
    },

    count(): number {
      ensureSorted()
      return entries.length
    },

    facetValueCounts(matched: Uint32Array): Map<number, number> {
      ensureSorted()
      const counts = new Map<number, number>()
      let i = 0
      while (i < entries.length) {
        const value = entries[i].value
        let runEnd = i + 1
        while (runEnd < entries.length && entries[runEnd].value === value) runEnd++
        if (runEnd - i === 1) {
          if (bitsetHas(matched, entries[i].docId)) counts.set(value, 1)
        } else {
          const seen = new Set<number>()
          for (let j = i; j < runEnd; j++) {
            const docId = entries[j].docId
            if (bitsetHas(matched, docId)) seen.add(docId)
          }
          if (seen.size > 0) counts.set(value, seen.size)
        }
        i = runEnd
      }
      return counts
    },

    facetRangeCount(from: number, to: number, matched: Uint32Array): number {
      ensureSorted()
      const start = lowerBound(entries, from)
      const end = lowerBound(entries, to)
      const seen = new Set<number>()
      for (let i = start; i < end; i++) {
        const docId = entries[i].docId
        if (bitsetHas(matched, docId)) seen.add(docId)
      }
      return seen.size
    },

    clear(): void {
      entries = []
      discardPending()
    },

    serialize(): NumericIndexEntry[] {
      ensureSorted()
      return entries.slice()
    },

    deserialize(data: NumericIndexEntry[]): void {
      entries = data.slice()
      discardPending()
    },
  }
}
