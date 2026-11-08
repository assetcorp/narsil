import {
  bitsetSet,
  compareCodePoints,
  createBitSet,
  getFlatSchema,
  keptFacetValues,
  storedValuesOf,
} from '../../engine/optional-reads-host-bindings'
import type { FacetResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { countRangeFacets } from '../facets/adapter'
import { countStoredFacet, countStoredRanges } from '../facets/stored-adapter'
import type { PartitionReadState, PartitionState } from './utils'

type FacetRange = { from: number; to: number }

const UNDECLARED_FIELD_TYPE = ''

export interface FacetOrdinalSet {
  readonly ordinalBitset: Uint32Array
}

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

function countValuesFromDocuments(
  state: PartitionReadState,
  fieldPath: string,
  matched: FacetMatchSet,
): Map<string, number> {
  return countStoredFacet(storedValuesOf(state.docStore, fieldPath), ordinalBitsetOf(state, matched))
}

function countNumericRanges(
  state: PartitionReadState,
  fieldPath: string,
  ranges: readonly FacetRange[],
  bitset: () => Uint32Array,
): Map<string, number> {
  const counts = new Map<string, number>()
  const index = state.numericIndexes.get(fieldPath)
  const bounds = new Float64Array(ranges.length * 2)
  for (let at = 0; at < ranges.length; at++) {
    bounds[at * 2] = ranges[at].from
    bounds[at * 2 + 1] = ranges[at].to
  }
  const totals =
    index === undefined
      ? countStoredRanges(storedValuesOf(state.docStore, fieldPath), bitset(), bounds)
      : countRangeFacets(index.regions(), bitset(), bounds)
  for (let at = 0; at < ranges.length; at++) counts.set(`${ranges[at].from}-${ranges[at].to}`, totals[at])
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

export function sortFacetedNumbers(state: PartitionState, config: FacetConfig, schema: SchemaDefinition): void {
  const flatSchema = getFlatSchema(state, schema)
  for (const fieldPath of Object.keys(config)) {
    const fieldType = flatSchema[fieldPath]
    if (fieldType !== 'number' && fieldType !== 'number[]') continue
    state.numericIndexes.get(fieldPath)?.sortPending()
  }
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
    const fieldType: string = flatSchema[fieldPath] ?? UNDECLARED_FIELD_TYPE

    const valueCounts =
      facetOpts.ranges && (fieldType === 'number' || fieldType === 'number[]' || fieldType === UNDECLARED_FIELD_TYPE)
        ? countNumericRanges(state, fieldPath, facetOpts.ranges, bitset)
        : countFieldValues(state, fieldPath, fieldType, bitset, matched)

    const ordered = Array.from(valueCounts.entries())
    const sortDir = facetOpts.sort ?? 'desc'
    ordered.sort((a, b) => (sortDir === 'asc' ? a[1] - b[1] : b[1] - a[1]) || compareCodePoints(a[0], b[0]))

    const keep = Math.min(keptFacetValues(facetOpts.limit) ?? ordered.length, ordered.length)
    const entries = ordered.slice(0, keep)

    let errorBound = 0
    for (let index = keep; index < ordered.length; index++) {
      if (ordered[index][1] > errorBound) errorBound = ordered[index][1]
    }

    const values: Record<string, number> = Object.create(null)
    for (const [key, count] of entries) {
      values[key] = count
    }

    result[fieldPath] = { values, count: entries.length, errorBound }
  }

  return result
}
