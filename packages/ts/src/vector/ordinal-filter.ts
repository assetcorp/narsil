/**
 * A filter over store ordinals, one bit per ordinal, with the number of set
 * bits alongside so a search can judge selectivity without a scan.
 *
 * A search checks membership by indexing a byte array rather than hashing a
 * document id, and the whole filter posts to a worker as a few kilobytes of
 * bytes rather than a set of strings.
 *
 * @internal
 */
export interface OrdinalFilter {
  /** One bit per ordinal, set where the ordinal passes the filter. */
  bits: Uint8Array
  /** This many ordinals pass the filter. */
  count: number
}

export function createOrdinalFilter(slots: number): OrdinalFilter {
  return { bits: new Uint8Array((slots + 7) >>> 3), count: 0 }
}

export function addToOrdinalFilter(filter: OrdinalFilter, ordinal: number): void {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return
  const bit = 1 << (ordinal & 7)
  if ((filter.bits[index] & bit) !== 0) return
  filter.bits[index] |= bit
  filter.count += 1
}

export function ordinalFilterHas(filter: OrdinalFilter, ordinal: number): boolean {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return false
  return (filter.bits[index] & (1 << (ordinal & 7))) !== 0
}

export function removeFromOrdinalFilter(filter: OrdinalFilter, ordinal: number): void {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return
  const bit = 1 << (ordinal & 7)
  if ((filter.bits[index] & bit) === 0) return
  filter.bits[index] &= ~bit
  filter.count -= 1
}

export function* ordinalFilterValues(filter: OrdinalFilter): IterableIterator<number> {
  const bits = filter.bits
  for (let index = 0; index < bits.length; index++) {
    const byte = bits[index]
    if (byte === 0) continue
    for (let offset = 0; offset < 8; offset++) {
      if ((byte & (1 << offset)) !== 0) yield (index << 3) | offset
    }
  }
}
