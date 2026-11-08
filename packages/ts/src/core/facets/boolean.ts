import { regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeFacetCore } from '../../vector/native/types/facets'

function countMatches(bits: Uint32Array, matched: Uint32Array): number {
  let count = 0
  const length = Math.min(bits.length, matched.length)
  for (let index = 0; index < length; index++) {
    let word = bits[index] & matched[index]
    word -= (word >>> 1) & 0x55555555
    word = (word & 0x33333333) + ((word >>> 2) & 0x33333333)
    count += (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  return count
}

export const booleanFacet: NativeFacetCore['booleanFacet'] = (trueInput, falseInput, matchedInput, countsInput) => {
  const trueBits = typedRegion(trueInput, 'Uint32Array')
  const falseBits = typedRegion(falseInput, 'Uint32Array')
  const matched = typedRegion(matchedInput, 'Uint32Array')
  const counts = typedRegion(countsInput, 'Uint32Array')
  if (
    trueBits === null ||
    falseBits === null ||
    matched === null ||
    counts === null ||
    trueBits.length === 0 ||
    falseBits.length === 0 ||
    matched.length === 0
  )
    return -1
  if ([trueBits, falseBits, matched].some(input => regionsOverlap(input, counts))) return -1
  if (counts.length < 2) return -3
  const trueCount = countMatches(trueBits, matched)
  const falseCount = countMatches(falseBits, matched)
  if (trueCount > 0xffffffff || falseCount > 0xffffffff) return -1
  counts[0] = trueCount
  counts[1] = falseCount
  return 0
}
