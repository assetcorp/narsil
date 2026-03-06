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

function collectDocIds(entries: NumericIndexEntry[], from: number, to: number): Set<string> {
  const result = new Set<string>()
  for (let i = from; i < to; i++) {
    result.add(entries[i].docId)
  }
  return result
}

export interface NumericFieldIndex {
  insert(docId: string, value: number): void
  remove(docId: string, value: number): void
  queryEq(value: number): Set<string>
  queryNe(value: number): Set<string>
  queryGt(value: number): Set<string>
  queryGte(value: number): Set<string>
  queryLt(value: number): Set<string>
  queryLte(value: number): Set<string>
  queryBetween(min: number, max: number): Set<string>
  getAllDocIds(): Set<string>
  count(): number
  clear(): void
  serialize(): NumericIndexEntry[]
  deserialize(data: NumericIndexEntry[]): void
}

export function createNumericIndex(): NumericFieldIndex {
  let entries: NumericIndexEntry[] = []

  return {
    insert(docId: string, value: number): void {
      const pos = upperBound(entries, value)
      entries.splice(pos, 0, { value, docId })
    },

    remove(docId: string, value: number): void {
      const start = lowerBound(entries, value)
      const end = upperBound(entries, value)
      for (let i = start; i < end; i++) {
        if (entries[i].docId === docId) {
          entries.splice(i, 1)
          return
        }
      }
    },

    queryEq(value: number): Set<string> {
      return collectDocIds(entries, lowerBound(entries, value), upperBound(entries, value))
    },

    queryNe(value: number): Set<string> {
      const excluded = this.queryEq(value)
      const result = new Set<string>()
      for (const entry of entries) {
        if (!excluded.has(entry.docId)) result.add(entry.docId)
      }
      return result
    },

    queryGt(value: number): Set<string> {
      return collectDocIds(entries, upperBound(entries, value), entries.length)
    },

    queryGte(value: number): Set<string> {
      return collectDocIds(entries, lowerBound(entries, value), entries.length)
    },

    queryLt(value: number): Set<string> {
      return collectDocIds(entries, 0, lowerBound(entries, value))
    },

    queryLte(value: number): Set<string> {
      return collectDocIds(entries, 0, upperBound(entries, value))
    },

    queryBetween(min: number, max: number): Set<string> {
      return collectDocIds(entries, lowerBound(entries, min), upperBound(entries, max))
    },

    getAllDocIds(): Set<string> {
      return collectDocIds(entries, 0, entries.length)
    },

    count(): number {
      return entries.length
    },

    clear(): void {
      entries = []
    },

    serialize(): NumericIndexEntry[] {
      return entries.slice()
    },

    deserialize(data: NumericIndexEntry[]): void {
      entries = data.slice()
    },
  }
}

export interface BooleanFieldIndex {
  insert(docId: string, value: boolean): void
  remove(docId: string, value: boolean): void
  queryEq(value: boolean): Set<string>
  queryNe(value: boolean): Set<string>
  getAllDocIds(): Set<string>
  count(): number
  clear(): void
  serialize(): { trueDocs: string[]; falseDocs: string[] }
  deserialize(data: { trueDocs: string[]; falseDocs: string[] }): void
}

export function createBooleanIndex(): BooleanFieldIndex {
  const trueDocs = new Set<string>()
  const falseDocs = new Set<string>()

  return {
    insert(docId: string, value: boolean): void {
      if (value) trueDocs.add(docId)
      else falseDocs.add(docId)
    },

    remove(docId: string, value: boolean): void {
      if (value) trueDocs.delete(docId)
      else falseDocs.delete(docId)
    },

    queryEq(value: boolean): Set<string> {
      return new Set(value ? trueDocs : falseDocs)
    },

    queryNe(value: boolean): Set<string> {
      return new Set(value ? falseDocs : trueDocs)
    },

    getAllDocIds(): Set<string> {
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

    serialize(): { trueDocs: string[]; falseDocs: string[] } {
      return {
        trueDocs: Array.from(trueDocs),
        falseDocs: Array.from(falseDocs),
      }
    },

    deserialize(data: { trueDocs: string[]; falseDocs: string[] }): void {
      trueDocs.clear()
      falseDocs.clear()
      for (const id of data.trueDocs) trueDocs.add(id)
      for (const id of data.falseDocs) falseDocs.add(id)
    },
  }
}

export interface EnumFieldIndex {
  insert(docId: string, value: string): void
  remove(docId: string, value: string): void
  queryEq(value: string): Set<string>
  queryNe(value: string): Set<string>
  queryIn(values: string[]): Set<string>
  queryNin(values: string[]): Set<string>
  getAllDocIds(): Set<string>
  count(): number
  clear(): void
  serialize(): Record<string, string[]>
  deserialize(data: Record<string, string[]>): void
}

export function createEnumIndex(): EnumFieldIndex {
  const valueMap = new Map<string, Set<string>>()

  function allDocs(): Set<string> {
    const result = new Set<string>()
    for (const docSet of valueMap.values()) {
      for (const id of docSet) result.add(id)
    }
    return result
  }

  return {
    insert(docId: string, value: string): void {
      let docSet = valueMap.get(value)
      if (!docSet) {
        docSet = new Set()
        valueMap.set(value, docSet)
      }
      docSet.add(docId)
    },

    remove(docId: string, value: string): void {
      const docSet = valueMap.get(value)
      if (!docSet) return
      docSet.delete(docId)
      if (docSet.size === 0) valueMap.delete(value)
    },

    queryEq(value: string): Set<string> {
      const docSet = valueMap.get(value)
      return docSet ? new Set(docSet) : new Set()
    },

    queryNe(value: string): Set<string> {
      const excluded = valueMap.get(value)
      const result = allDocs()
      if (excluded) {
        for (const id of excluded) result.delete(id)
      }
      return result
    },

    queryIn(values: string[]): Set<string> {
      const result = new Set<string>()
      for (const val of values) {
        const docSet = valueMap.get(val)
        if (docSet) {
          for (const id of docSet) result.add(id)
        }
      }
      return result
    },

    queryNin(values: string[]): Set<string> {
      const excluded = this.queryIn(values)
      const result = allDocs()
      for (const id of excluded) result.delete(id)
      return result
    },

    getAllDocIds(): Set<string> {
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

    serialize(): Record<string, string[]> {
      const result: Record<string, string[]> = {}
      for (const [value, docSet] of valueMap) {
        result[value] = Array.from(docSet)
      }
      return result
    },

    deserialize(data: Record<string, string[]>): void {
      valueMap.clear()
      for (const value of Object.keys(data)) {
        valueMap.set(value, new Set(data[value]))
      }
    },
  }
}
