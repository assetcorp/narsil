import { bitsetSet, createBitSet } from '../bitset'

export interface EnumFieldIndex {
  insert(internalId: number, value: string): void
  remove(internalId: number, value: string): void
  queryEq(value: string): Set<number>
  queryNe(value: string): Set<number>
  queryIn(values: string[]): Set<number>
  queryNin(values: string[]): Set<number>
  getAllDocIds(): Set<number>
  queryEqBitset(value: string, capacity: number): Uint32Array
  queryInBitset(values: string[], capacity: number): Uint32Array
  getAllDocIdsBitset(capacity: number): Uint32Array
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

    queryEqBitset(value: string, capacity: number): Uint32Array {
      const bs = createBitSet(capacity)
      const docSet = valueMap.get(value)
      if (docSet) {
        for (const id of docSet) bitsetSet(bs, id)
      }
      return bs
    },

    queryInBitset(values: string[], capacity: number): Uint32Array {
      const bs = createBitSet(capacity)
      for (const val of values) {
        const docSet = valueMap.get(val)
        if (docSet) {
          for (const id of docSet) bitsetSet(bs, id)
        }
      }
      return bs
    },

    getAllDocIdsBitset(capacity: number): Uint32Array {
      const bs = createBitSet(capacity)
      for (const docSet of valueMap.values()) {
        for (const id of docSet) bitsetSet(bs, id)
      }
      return bs
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
