import { storedRangeFacet, valueFacet } from '#platform/facet-count'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { storedText } from '../stored-values/text'

const EMPTY_MATCHES = new Uint32Array(1)

export function countStoredRanges(values: NativeStoredValues, matched: Uint32Array, ranges: Float64Array): Uint32Array {
  const counts = new Uint32Array(ranges.length / 2)
  const status = storedRangeFacet(values, matched.length === 0 ? EMPTY_MATCHES : matched, ranges, counts)
  if (status !== 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored numeric ranges could not be counted', {
      status: -status,
    })
  return counts
}

export function countStoredFacet(values: NativeStoredValues, matched: Uint32Array): Map<string, number> {
  const positions = new Uint32Array(values.kinds.length)
  const counts = new Uint32Array(values.kinds.length)
  const count = valueFacet(values, matched.length === 0 ? EMPTY_MATCHES : matched, positions, counts)
  if (count < 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored values could not be counted', { status: -count })
  const buckets = new Map<string, number>()
  for (let at = 0; at < count; at++) {
    const position = positions[at]
    const kind = values.kinds[position]
    const key =
      kind === 1
        ? 'false'
        : kind === 2
          ? 'true'
          : kind === 3
            ? String(values.numbers[position])
            : storedText(values.units, values.textStart[position], values.textLength[position])
    buckets.set(key, (buckets.get(key) ?? 0) + counts[at])
  }
  return buckets
}
