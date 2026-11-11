import { countEnumFacet } from '../../search/facets'
import { buildEnumRegions, type EnumRegions, enumRegionBytes } from './enum-regions'
import { FieldPresence } from './presence'

export interface EnumFieldIndexReader {
  regionBytes(): number
  regions(): EnumRegions
  getAllDocIdsBitset(capacity: number): Uint32Array
  count(): number
  serialize(): Record<string, number[]>
  facetCounts(matched: Uint32Array): Map<string, number>
}

export interface EnumFieldIndex extends EnumFieldIndexReader {
  insert(internalId: number, value: string): void
  remove(internalId: number, value: string): void
  clear(): void
  deserialize(data: Record<string, number[]>): void
}

export function createEnumIndex(): EnumFieldIndex {
  const valueMap = new Map<string, Set<number>>()
  let held: EnumRegions | null = null
  const present = new FieldPresence(function* () {
    for (const ids of valueMap.values()) yield* ids
  })

  function regions(): EnumRegions {
    held ??= buildEnumRegions(valueMap)
    return held
  }

  return {
    regions,
    regionBytes: () => present.bytes() + enumRegionBytes(held),
    insert(internalId: number, value: string): void {
      let docSet = valueMap.get(value)
      if (!docSet) {
        docSet = new Set()
        valueMap.set(value, docSet)
      }
      if (!docSet.has(internalId)) {
        present.invalidate()
        held = null
        docSet.add(internalId)
      }
    },

    remove(internalId: number, value: string): void {
      const docSet = valueMap.get(value)
      if (!docSet) return
      if (!docSet.delete(internalId)) return
      present.invalidate()
      held = null
      if (docSet.size > 0) return
      valueMap.delete(value)
    },

    getAllDocIdsBitset(capacity: number): Uint32Array {
      return present.regions(capacity)
    },

    count(): number {
      let total = 0
      for (const docSet of valueMap.values()) total += docSet.size
      return total
    },

    facetCounts(matched: Uint32Array): Map<string, number> {
      const index = regions()
      return countEnumFacet(index.values, index.postingOffsets, index.postings, matched)
    },

    clear(): void {
      present.invalidate()
      held = null
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
      present.invalidate()
      held = null
      valueMap.clear()
      for (const value of Object.keys(data)) {
        valueMap.set(value, new Set(data[value]))
      }
    },
  }
}
