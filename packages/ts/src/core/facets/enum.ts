import type { NativeFacetCore } from '../../vector/native/types/facets'
import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { countSpan, prepareSeen } from './numeric'

export const enumFacet: NativeFacetCore['enumFacet'] = (offsetsInput, postingsInput, matchedInput, countsOutput) => {
  const offsets = typedRegion(offsetsInput, 'Uint32Array')
  const postings = typedRegion(postingsInput, 'Uint32Array')
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const outCounts = typedRegion(countsOutput, 'Uint32Array')
  if (
    offsets === null ||
    postings === null ||
    matched === null ||
    outCounts === null ||
    offsets.length === 0 ||
    offsets.length - 1 > 0xffffffff ||
    postings.length > 0xffffffff ||
    matched.length === 0
  )
    return -1
  if ([offsets, postings, matched].some(input => regionsOverlap(input, outCounts))) return -1
  const count = offsets.length - 1
  if (outCounts.length < count) return -3
  if (count === 0) return 0
  prepareSeen(matched.length)
  const counts = new Uint32Array(count)
  for (let at = 0; at < count; at++) {
    const start = offsets[at]
    const end = offsets[at + 1]
    if (start <= end && end <= postings.length) counts[at] = countSpan(postings, matched, start, end)
  }
  outCounts.set(counts)
  return 0
}
