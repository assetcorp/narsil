import type { NumericIndexEntry } from '../types/internal'

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

export interface BooleanFieldIndex {
  insert(internalId: number, value: boolean): void
  remove(internalId: number, value: boolean): void
  queryEq(value: boolean): Set<number>
  queryNe(value: boolean): Set<number>
  getAllDocIds(): Set<number>
  count(): number
  clear(): void
  serialize(): { trueDocs: number[]; falseDocs: number[] }
  deserialize(data: { trueDocs: number[]; falseDocs: number[] }): void
}

export function createBooleanIndex(): BooleanFieldIndex {
  const trueDocs = new Set<number>()
  const falseDocs = new Set<number>()

  return {
    insert(internalId: number, value: boolean): void {
      if (value) trueDocs.add(internalId)
      else falseDocs.add(internalId)
    },

    remove(internalId: number, value: boolean): void {
      if (value) trueDocs.delete(internalId)
      else falseDocs.delete(internalId)
    },

    queryEq(value: boolean): Set<number> {
      return new Set(value ? trueDocs : falseDocs)
    },

    queryNe(value: boolean): Set<number> {
      return new Set(value ? falseDocs : trueDocs)
    },

    getAllDocIds(): Set<number> {
      const all = new Set(trueDocs)
      for (const id of falseDocs) all.add(id)
      return all
    },

    count(): number {
      return trueDocs.size + falseDocs.size
    },

    clear(): void {
      trueDocs.clear()
      falseDocs.clear()
    },

    serialize(): { trueDocs: number[]; falseDocs: number[] } {
      return {
        trueDocs: Array.from(trueDocs),
        falseDocs: Array.from(falseDocs),
      }
    },

    deserialize(data: { trueDocs: number[]; falseDocs: number[] }): void {
      trueDocs.clear()
      falseDocs.clear()
      for (const id of data.trueDocs) trueDocs.add(id)
      for (const id of data.falseDocs) falseDocs.add(id)
    },
  }
}

export interface EnumFieldIndex {
  insert(internalId: number, value: string): void
  remove(internalId: number, value: string): void
  queryEq(value: string): Set<number>
  queryNe(value: string): Set<number>
  queryIn(values: string[]): Set<number>
  queryNin(values: string[]): Set<number>
  getAllDocIds(): Set<number>
  count(): number
  clear(): void
  serialize(): Record<string, number[]>
  deserialize(data: Record<string, number[]>): void
}

export function createEnumIndex(): EnumFieldIndex {
  const valueMap = new Map<string, Set<number>>()

  function allDocs(): Set<number> {
    const result = new Set<number>()
    for (const docSet of valueMap.values()) {
      for (const id of docSet) result.add(id)
    }
    return result
  }

  return {
    insert(internalId: number, value: string): void {
      let docSet = valueMap.get(value)
      if (!docSet) {
        docSet = new Set()
        valueMap.set(value, docSet)
      }
      docSet.add(internalId)
    },

    remove(internalId: number, value: string): void {
      const docSet = valueMap.get(value)
      if (!docSet) return
      docSet.delete(internalId)
      if (docSet.size === 0) valueMap.delete(value)
    },

    queryEq(value: string): Set<number> {
      const docSet = valueMap.get(value)
      return docSet ? new Set(docSet) : new Set()
    },

    queryNe(value: string): Set<number> {
      const excluded = valueMap.get(value)
      const result = allDocs()
      if (excluded) {
        for (const id of excluded) result.delete(id)
      }
      return result
    },

    queryIn(values: string[]): Set<number> {
      const result = new Set<number>()
      for (const val of values) {
        const docSet = valueMap.get(val)
        if (docSet) {
          for (const id of docSet) result.add(id)
        }
      }
      return result
    },

    queryNin(values: string[]): Set<number> {
      const excluded = this.queryIn(values)
      const result = allDocs()
      for (const id of excluded) result.delete(id)
      return result
    },

    getAllDocIds(): Set<number> {
      return allDocs()
    },

    count(): number {
      let total = 0
      for (const docSet of valueMap.values()) total += docSet.size
      return total
    },

    clear(): void {
      valueMap.clear()
    },

    serialize(): Record<string, number[]> {
      const result: Record<string, number[]> = Object.create(null)
      for (const [value, docSet] of valueMap) {
        result[value] = Array.from(docSet)
      }
      return result
    },

    deserialize(data: Record<string, number[]>): void {
      valueMap.clear()
      for (const value of Object.keys(data)) {
        valueMap.set(value, new Set(data[value]))
      }
    },
  }
}
