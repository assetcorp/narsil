import { readStoredFields, regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeFacetCore } from '../../vector/native/types/facets'
import { compareStoredElements } from '../stored-values/compare'

export const valueFacet: NativeFacetCore['valueFacet'] = (valuesInput, matchedInput, valuesOutput, countsOutput) => {
  const fields = readStoredFields([valuesInput])
  const values = fields?.[0]
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const outValues = typedRegion(valuesOutput, 'Uint32Array')
  const outCounts = typedRegion(countsOutput, 'Uint32Array')
  if (values === undefined || matched === null || outValues === null || outCounts === null || matched.length === 0)
    return -1
  if (
    regionsOverlap(outValues, outCounts) ||
    [...Object.values(values), matched].some(
      input => regionsOverlap(input, outValues) || regionsOverlap(input, outCounts),
    )
  )
    return -1
  const counts = new Uint32Array(values.kinds.length)
  for (let ordinal = 0; ordinal < values.shapes.length; ordinal++) {
    const word = ordinal >>> 5
    if (word >= matched.length || (matched[word] & (1 << (ordinal & 31))) === 0) continue
    const shape = values.shapes[ordinal]
    const start = values.starts[ordinal]
    const end = values.starts[ordinal + 1]
    if (shape === 0 || shape > 2 || start > end || end > counts.length || (shape === 1 && end - start !== 1)) continue
    for (let at = start; at < end; at++) {
      const kind = values.kinds[at]
      if (kind < 1 || kind > 4) continue
      if (
        kind === 4 &&
        (values.textStart[at] > values.units.length ||
          values.textLength[at] > values.units.length - values.textStart[at])
      )
        continue
      if (counts[at] === 0xffffffff) return -1
      counts[at]++
    }
  }
  const positions: number[] = []
  for (let at = 0; at < counts.length; at++) if (counts[at] > 0) positions.push(at)
  positions.sort((left, right) => compareStoredElements(values, left, right))
  let buckets = 0
  for (let start = 0; start < positions.length; ) {
    const first = positions[start]
    let total = counts[first]
    let end = start + 1
    while (end < positions.length && compareStoredElements(values, first, positions[end]) === 0) {
      total += counts[positions[end++]]
      if (total > 0xffffffff) return -1
    }
    positions[buckets++] = first
    counts[first] = total
    start = end
  }
  if (buckets > outValues.length || buckets > outCounts.length) return -3
  for (let at = 0; at < buckets; at++) {
    const first = positions[at]
    outValues[at] = first
    outCounts[at] = counts[first]
  }
  return buckets
}
