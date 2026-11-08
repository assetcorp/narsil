import { booleanFacet, enumFacet, numberFacet, rangeFacet } from '#platform/facet-count'
import { ErrorCodes, NarsilError } from '../../engine/optional-reads-host-bindings'
import type { NumericRegions } from '../field-index/numeric/storage'

const counts = new Uint32Array(2)
const emptyMatches = new Uint32Array(1)

export function countEnumFacet(
  values: readonly string[],
  offsets: Uint32Array,
  postings: Uint32Array,
  matched: Uint32Array,
): Map<string, number> {
  const counts = new Uint32Array(values.length)
  const status = enumFacet(offsets, postings, matched.length === 0 ? emptyMatches : matched, counts)
  if (status !== 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The enum facet could not be counted', { status: -status })
  const buckets = new Map<string, number>()
  for (let at = 0; at < values.length; at++) if (counts[at] > 0) buckets.set(values[at], counts[at])
  return buckets
}

export function countNumberFacet(index: NumericRegions, matched: Uint32Array): Map<number, number> {
  const values = new Float64Array(index.values.length)
  const counts = new Uint32Array(index.values.length)
  const count = numberFacet(index.values, index.ordinals, matched.length === 0 ? emptyMatches : matched, values, counts)
  if (count < 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The numeric facet could not be counted', { status: -count })
  const buckets = new Map<number, number>()
  for (let at = 0; at < count; at++) buckets.set(values[at], counts[at])
  return buckets
}

export function countRangeFacets(index: NumericRegions, matched: Uint32Array, ranges: Float64Array): Uint32Array {
  const counts = new Uint32Array(ranges.length / 2)
  const status = rangeFacet(index.values, index.ordinals, matched.length === 0 ? emptyMatches : matched, ranges, counts)
  if (status !== 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The numeric ranges could not be counted', { status: -status })
  return counts
}

export function countBooleanFacet(
  trueBits: Uint32Array,
  falseBits: Uint32Array,
  matched: Uint32Array,
): { trueCount: number; falseCount: number } {
  const status = booleanFacet(trueBits, falseBits, matched.length === 0 ? emptyMatches : matched, counts)
  if (status !== 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The boolean facet could not be counted', { status: -status })
  return { trueCount: counts[0], falseCount: counts[1] }
}
