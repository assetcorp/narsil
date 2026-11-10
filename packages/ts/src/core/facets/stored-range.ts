import { readStoredFields, regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeFacetCore } from '../../vector/native/types/facets'

export const storedRangeFacet: NativeFacetCore['storedRangeFacet'] = (
  valuesInput,
  matchedInput,
  rangesInput,
  output,
) => {
  const values = readStoredFields([valuesInput])?.[0]
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const ranges = typedRegion(rangesInput, 'Float64Array')
  const counts = typedRegion(output, 'Uint32Array')
  if (
    values === undefined ||
    matched === null ||
    ranges === null ||
    counts === null ||
    matched.length === 0 ||
    ranges.length % 2 !== 0 ||
    ranges.length / 2 > 0xffffffff
  )
    return -1
  if ([...Object.values(values), matched, ranges].some(input => regionsOverlap(input, counts))) return -1
  const rangeCount = ranges.length / 2
  if (counts.length < rangeCount) return -3
  for (let range = 0; range < rangeCount; range++) {
    const from = ranges[range * 2]
    const to = ranges[range * 2 + 1]
    let total = 0
    if (from < to) {
      for (let ordinal = 0; ordinal < values.shapes.length; ordinal++) {
        const word = ordinal >>> 5
        if (word >= matched.length || (matched[word] & (1 << (ordinal & 31))) === 0) continue
        const shape = values.shapes[ordinal]
        const start = values.starts[ordinal]
        const end = values.starts[ordinal + 1]
        if (shape === 0 || shape > 2 || start > end || end > values.kinds.length || (shape === 1 && end - start !== 1))
          continue
        for (let at = start; at < end; at++) {
          if (values.kinds[at] !== 3) continue
          const value = values.numbers[at]
          if (value >= from && value < to) {
            total++
            break
          }
        }
      }
    }
    counts[range] = total
  }
  return 0
}
