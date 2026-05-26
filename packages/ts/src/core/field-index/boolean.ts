import { bitsetSet, createBitSet } from '../bitset'

export interface BooleanFieldIndex {
  insert(internalId: number, value: boolean): void
  remove(internalId: number, value: boolean): void
  queryEq(value: boolean): Set<number>
  queryNe(value: boolean): Set<number>
  getAllDocIds(): Set<number>
  queryEqBitset(value: boolean, capacity: number): Uint32Array
  getAllDocIdsBitset(capacity: number): Uint32Array
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

    queryEqBitset(value: boolean, capacity: number): Uint32Array {
      const source = value ? trueDocs : falseDocs
      const bs = createBitSet(capacity)
      for (const id of source) {
        bitsetSet(bs, id)
      }
      return bs
    },

    getAllDocIdsBitset(capacity: number): Uint32Array {
      const bs = createBitSet(capacity)
      for (const id of trueDocs) bitsetSet(bs, id)
      for (const id of falseDocs) bitsetSet(bs, id)
      return bs
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
