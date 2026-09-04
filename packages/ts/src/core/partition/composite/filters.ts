import type { FilterExpression } from '../../../types/filters'
import type { SchemaDefinition } from '../../../types/schema'
import { bitsetHas } from '../../bitset'
import { applyPartitionFilters, applyPartitionFiltersBitset, type PartitionFilterMatches } from '../filters'
import type { PartitionReadState } from '../read-state'

export interface OrdinalLayout {
  readonly bases: readonly number[]
  readonly totalCapacity: number
}

const WORD_BITS = 32

function alignToWord(value: number): number {
  return (value + WORD_BITS - 1) & ~(WORD_BITS - 1)
}

export function computeOrdinalLayout(subs: readonly PartitionReadState[]): OrdinalLayout {
  const bases: number[] = new Array(subs.length)
  let cursor = 0
  for (let i = 0; i < subs.length; i++) {
    bases[i] = cursor
    cursor += alignToWord(subs[i].docStore.internalIdCapacity())
  }
  return { bases, totalCapacity: cursor }
}

export function subBitsetView(composite: Uint32Array, layout: OrdinalLayout, subIndex: number): Uint32Array {
  const startWord = layout.bases[subIndex] >> 5
  const endWord =
    subIndex + 1 < layout.bases.length ? layout.bases[subIndex + 1] >> 5 : Math.ceil(layout.totalCapacity / WORD_BITS)
  return composite.subarray(startWord, endWord)
}

export function placeSubBitset(
  composite: Uint32Array,
  layout: OrdinalLayout,
  subIndex: number,
  subBits: Uint32Array,
): void {
  const words = subBitsetView(composite, layout, subIndex).length
  if (words === 0) return
  composite.set(subBits.length > words ? subBits.subarray(0, words) : subBits, layout.bases[subIndex] >> 5)
}

export function compositeFiltersBitset(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  filters: FilterExpression,
  schema: SchemaDefinition,
): Uint32Array {
  const composite = new Uint32Array(Math.ceil(layout.totalCapacity / WORD_BITS))
  for (let i = 0; i < subs.length; i++) {
    placeSubBitset(composite, layout, i, applyPartitionFiltersBitset(subs[i], filters, schema))
  }
  return composite
}

export function compositeFilters(
  subs: readonly PartitionReadState[],
  filters: FilterExpression,
  schema: SchemaDefinition,
): Set<string> {
  const combined = new Set<string>()
  for (const sub of subs) {
    for (const docId of applyPartitionFilters(sub, filters, schema)) {
      combined.add(docId)
    }
  }
  return combined
}

export function compositeFilterMatches(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  filters: FilterExpression,
  schema: SchemaDefinition,
): PartitionFilterMatches {
  const bits = compositeFiltersBitset(subs, layout, filters, schema)

  let count = 0
  for (let i = 0; i < subs.length; i++) {
    const resolver = subs[i].docStore.resolver()
    const view = subBitsetView(bits, layout, i)
    for (let wordIndex = 0; wordIndex < view.length; wordIndex++) {
      let word = view[wordIndex]
      if (word === 0) continue
      const base = wordIndex << 5
      while (word !== 0) {
        const trailingZeros = Math.clz32(word & -word) ^ 31
        if (resolver.toExternal(base + trailingZeros) !== undefined) count++
        word &= word - 1
      }
    }
  }

  return {
    count,
    hasExternal(docId: string): boolean {
      for (let i = 0; i < subs.length; i++) {
        const internalId = subs[i].docStore.getInternalId(docId)
        if (internalId !== undefined) return bitsetHas(bits, layout.bases[i] + internalId)
      }
      return false
    },
    hasInternal(internalId: number): boolean {
      return bitsetHas(bits, internalId)
    },
  }
}

export function subMatchesView(
  matches: PartitionFilterMatches,
  layout: OrdinalLayout,
  subIndex: number,
): PartitionFilterMatches {
  const base = layout.bases[subIndex]
  return {
    count: matches.count,
    hasExternal: (docId: string) => matches.hasExternal(docId),
    hasInternal: (internalId: number) => matches.hasInternal(base + internalId),
  }
}
