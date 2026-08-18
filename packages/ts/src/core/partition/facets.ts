import type { FacetResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { bitsetSet, createBitSet } from '../bitset'
import { compareCodePoints } from '../ordering'
import { getFieldValueByInternalId, getFieldValueForDoc, getFlatSchema, type PartitionReadState } from './utils'

type FacetRange = { from: number; to: number }

/**
 * The matched documents of one partition as a bit per ordinal, in the ordinal
 * space of the partition that ran the search. A compaction swap renumbers
 * frozen ordinals, so the bits are valid only inside the synchronous span
 * that produced them.
 *
 * @internal
 */
export interface FacetOrdinalSet {
  readonly ordinalBitset: Uint32Array
}

/**
 * The documents a facet count runs over: ordinals from a search in the same
 * process, or external ids from a result that crossed a thread or process.
 *
 * @internal
 */
export type FacetMatchSet = ReadonlySet<string> | FacetOrdinalSet

function ordinalBitsetOf(state: PartitionReadState, matched: FacetMatchSet): Uint32Array {
  if ('ordinalBitset' in matched) return matched.ordinalBitset
  const bitset = createBitSet(state.docStore.internalIdCapacity())
  for (const docId of matched) {
    const ordinal = state.docStore.getInternalId(docId)
    if (ordinal !== undefined) bitsetSet(bitset, ordinal)
  }
  return bitset
}

function* matchedFieldValues(state: PartitionReadState, fieldPath: string, matched: FacetMatchSet): Generator<unknown> {
  if ('ordinalBitset' in matched) {
    const bits = matched.ordinalBitset
    for (let wordIndex = 0; wordIndex < bits.length; wordIndex++) {
      let word = bits[wordIndex]
      if (word === 0) continue
      const base = wordIndex << 5
      while (word !== 0) {
        const trailingZeros = Math.clz32(word & -word) ^ 31
        yield getFieldValueByInternalId(state.docStore, base + trailingZeros, fieldPath)
        word &= word - 1
      }
    }
    return
  }
  for (const docId of matched) {
    yield getFieldValueForDoc(state.docStore, docId, fieldPath)
  }
}

function countValuesFromDocuments(
  state: PartitionReadState,
  fieldPath: string,
  matched: FacetMatchSet,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of matchedFieldValues(state, fieldPath, matched)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        const key = String(item)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    } else {
      const key = String(value)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function countRangeFromDocuments(
  state: PartitionReadState,
  fieldPath: string,
  fieldType: string,
  range: FacetRange,
  matched: FacetMatchSet,
): number {
  let count = 0
  for (const value of matchedFieldValues(state, fieldPath, matched)) {
    if (fieldType === 'number[]' && Array.isArray(value)) {
      for (const v of value as number[]) {
        if (v >= range.from && v < range.to) {
          count++
          break
        }
      }
    } else if (typeof value === 'number' && value >= range.from && value < range.to) {
      count++
    }
  }
  return count
}

function countNumericRanges(
  state: PartitionReadState,
  fieldPath: string,
  fieldType: string,
  ranges: readonly FacetRange[],
  bitset: () => Uint32Array,
  matched: FacetMatchSet,
): Map<string, number> {
  const counts = new Map<string, number>()
  const index = state.numericIndexes.get(fieldPath)
  for (const range of ranges) {
    const label = `${range.from}-${range.to}`
    if (index === undefined) {
      counts.set(label, countRangeFromDocuments(state, fieldPath, fieldType, range, matched))
    } else if (Number.isNaN(range.from) || Number.isNaN(range.to)) {
      counts.set(label, 0)
    } else {
      counts.set(label, index.facetRangeCount(range.from, range.to, bitset()))
    }
  }
  return counts
}

function countFieldValues(
  state: PartitionReadState,
  fieldPath: string,
  fieldType: string,
  bitset: () => Uint32Array,
  matched: FacetMatchSet,
): Map<string, number> {
  if (fieldType === 'enum' || fieldType === 'enum[]') {
    const index = state.enumIndexes.get(fieldPath)
    if (index !== undefined) return index.facetCounts(bitset())
  } else if (fieldType === 'boolean' || fieldType === 'boolean[]') {
    const index = state.booleanIndexes.get(fieldPath)
    if (index !== undefined) {
      const { trueCount, falseCount } = index.facetCounts(bitset())
      const counts = new Map<string, number>()
      if (trueCount > 0) counts.set('true', trueCount)
      if (falseCount > 0) counts.set('false', falseCount)
      return counts
    }
  } else if (fieldType === 'number' || fieldType === 'number[]') {
    const index = state.numericIndexes.get(fieldPath)
    if (index !== undefined) {
      const counts = new Map<string, number>()
      for (const [value, count] of index.facetValueCounts(bitset())) {
        counts.set(String(value), count)
      }
      return counts
    }
  }
  return countValuesFromDocuments(state, fieldPath, matched)
}

export function computeFacets(
  state: PartitionReadState,
  matched: FacetMatchSet,
  config: FacetConfig,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const result: Record<string, FacetResult> = {}
  const flatSchema = getFlatSchema(state, schema)
  let matchedBitset: Uint32Array | null = null

  const bitset = (): Uint32Array => {
    if (matchedBitset === null) matchedBitset = ordinalBitsetOf(state, matched)
    return matchedBitset
  }

  for (const [fieldPath, facetOpts] of Object.entries(config)) {
    const fieldType = flatSchema[fieldPath]
    if (!fieldType) continue

    const valueCounts =
      facetOpts.ranges && (fieldType === 'number' || fieldType === 'number[]')
        ? countNumericRanges(state, fieldPath, fieldType, facetOpts.ranges, bitset, matched)
        : countFieldValues(state, fieldPath, fieldType, bitset, matched)

    let entries = Array.from(valueCounts.entries())
    const sortDir = facetOpts.sort ?? 'desc'
    entries.sort((a, b) => (sortDir === 'asc' ? a[1] - b[1] : b[1] - a[1]) || compareCodePoints(a[0], b[0]))

    if (facetOpts.limit && facetOpts.limit > 0) {
      entries = entries.slice(0, facetOpts.limit)
    }

    const values: Record<string, number> = {}
    for (const [key, count] of entries) {
      values[key] = count
    }

    result[fieldPath] = { values, count: entries.length }
  }

  return result
}
