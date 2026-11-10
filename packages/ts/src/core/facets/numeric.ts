import { lowerBound, regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeFacetCore } from '../../vector/native/types/facets'

let seen = new Uint32Array(0)

export function countSpan(ordinals: Uint32Array, matched: Uint32Array, start: number, end: number): number {
  let count = 0
  for (let at = start; at < end; at++) {
    const ordinal = ordinals[at]
    const word = ordinal >>> 5
    const bit = 1 << (ordinal & 31)
    if (word < matched.length && (matched[word] & bit) !== 0 && (seen[word] & bit) === 0) {
      seen[word] |= bit
      count++
    }
  }
  for (let at = start; at < end; at++) {
    const ordinal = ordinals[at]
    const word = ordinal >>> 5
    if (word < matched.length) seen[word] &= ~(1 << (ordinal & 31))
  }
  return count
}

export function prepareSeen(words: number): void {
  const needed = Math.min(words, 0x08000000)
  if (seen.length < needed) seen = new Uint32Array(needed)
}

export const numberFacet: NativeFacetCore['numberFacet'] = (
  valuesInput,
  ordinalsInput,
  matchedInput,
  valuesOutput,
  countsOutput,
) => {
  const values = typedRegion(valuesInput, 'Float64Array')
  const ordinals = typedRegion(ordinalsInput, 'Uint32Array')
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const outValues = typedRegion(valuesOutput, 'Float64Array')
  const outCounts = typedRegion(countsOutput, 'Uint32Array')
  if (
    values === null ||
    ordinals === null ||
    matched === null ||
    outValues === null ||
    outCounts === null ||
    values.length > 0xffffffff ||
    values.length !== ordinals.length ||
    matched.length === 0
  )
    return -1
  if (
    regionsOverlap(outValues, outCounts) ||
    [values, ordinals, matched].some(input => regionsOverlap(input, outValues) || regionsOverlap(input, outCounts))
  )
    return -1
  prepareSeen(matched.length)
  const capacity = Math.min(outValues.length, outCounts.length, values.length)
  const bucketValues = new Float64Array(capacity)
  const bucketCounts = new Uint32Array(capacity)
  let buckets = 0
  for (let start = 0; start < values.length; ) {
    const value = values[start]
    let end = start + 1
    while (end < values.length && values[end] === value) end++
    if (!Number.isNaN(value)) {
      const count = countSpan(ordinals, matched, start, end)
      if (count > 0) {
        if (buckets === capacity) return -3
        bucketValues[buckets] = value === 0 ? 0 : value
        bucketCounts[buckets++] = count
      }
    }
    start = end
  }
  outValues.set(bucketValues.subarray(0, buckets))
  outCounts.set(bucketCounts.subarray(0, buckets))
  return buckets
}

export const rangeFacet: NativeFacetCore['rangeFacet'] = (
  valuesInput,
  ordinalsInput,
  matchedInput,
  rangesInput,
  countsOutput,
) => {
  const values = typedRegion(valuesInput, 'Float64Array')
  const ordinals = typedRegion(ordinalsInput, 'Uint32Array')
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const ranges = typedRegion(rangesInput, 'Float64Array')
  const outCounts = typedRegion(countsOutput, 'Uint32Array')
  if (
    values === null ||
    ordinals === null ||
    matched === null ||
    ranges === null ||
    outCounts === null ||
    values.length > 0xffffffff ||
    values.length !== ordinals.length ||
    matched.length === 0 ||
    ranges.length % 2 !== 0 ||
    ranges.length / 2 > 0xffffffff
  )
    return -1
  if ([values, ordinals, matched, ranges].some(input => regionsOverlap(input, outCounts))) return -1
  const count = ranges.length / 2
  if (outCounts.length < count) return -3
  if (count === 0) return 0
  prepareSeen(matched.length)
  const counts = new Uint32Array(count)
  for (let at = 0; at < count; at++) {
    const from = ranges[at * 2]
    const to = ranges[at * 2 + 1]
    if (!Number.isNaN(from) && !Number.isNaN(to))
      counts[at] = countSpan(ordinals, matched, lowerBound(values, from), lowerBound(values, to))
  }
  outCounts.set(counts)
  return 0
}
