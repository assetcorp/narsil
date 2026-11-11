import { RADIX_BITS, WORK_FLUSH_UNITS } from './constants'
import type { PhraseWork } from './work'

export function sortPhraseRows(
  documents: Uint32Array,
  order: Uint32Array,
  spare: Uint32Array,
  buckets: Uint32Array,
  work: PhraseWork,
): number {
  if (work.add(order.length) !== 0) return work.status
  let from = order
  let into = spare
  for (let shift = 0; shift < 32; shift += RADIX_BITS) {
    buckets.fill(0)
    for (let row = 0; row < order.length; row++) buckets[(documents[row] >>> shift) & (buckets.length - 1)]++
    let next = 0
    for (let digit = 0; digit < buckets.length; digit++) {
      const count = buckets[digit]
      buckets[digit] = next
      next += count
    }
    for (let at = 0; at < order.length; at++) {
      const row = from[at]
      into[buckets[(documents[row] >>> shift) & (buckets.length - 1)]++] = row
      if (at % WORK_FLUSH_UNITS === 0 && work.flush() !== 0) return work.status
    }
    const swap = from
    from = into
    into = swap
  }
  return 0
}
