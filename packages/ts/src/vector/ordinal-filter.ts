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

/**
 * Creates an empty ordinal filter spanning the given number of store slots.
 *
 * @param slots The number of ordinals the filter must cover.
 * @returns A filter with no ordinal set.
 *
 * @internal
 */
export function createOrdinalFilter(slots: number): OrdinalFilter {
  return { bits: new Uint8Array((slots + 7) >>> 3), count: 0 }
}

/**
 * Sets one ordinal in the filter, counting it once however often it is added.
 *
 * @param filter The filter to add to.
 * @param ordinal The store ordinal to set.
 *
 * @internal
 */
export function addToOrdinalFilter(filter: OrdinalFilter, ordinal: number): void {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return
  const bit = 1 << (ordinal & 7)
  if ((filter.bits[index] & bit) !== 0) return
  filter.bits[index] |= bit
  filter.count += 1
}

/**
 * Reports whether the filter holds the given ordinal, and answers false for
 * any ordinal beyond the slots the filter was created over.
 *
 * @param filter The filter to check.
 * @param ordinal The store ordinal to look up.
 * @returns True where the ordinal passes the filter.
 *
 * @internal
 */
export function ordinalFilterHas(filter: OrdinalFilter, ordinal: number): boolean {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return false
  return (filter.bits[index] & (1 << (ordinal & 7))) !== 0
}

/**
 * Clears one ordinal from the filter, counting the removal once however often
 * it is repeated.
 *
 * @param filter The filter to clear from.
 * @param ordinal The store ordinal to clear.
 *
 * @internal
 */
export function removeFromOrdinalFilter(filter: OrdinalFilter, ordinal: number): void {
  const index = ordinal >>> 3
  if (index >= filter.bits.length) return
  const bit = 1 << (ordinal & 7)
  if ((filter.bits[index] & bit) === 0) return
  filter.bits[index] &= ~bit
  filter.count -= 1
}

/**
 * Yields every ordinal the filter holds, in ascending order.
 *
 * @param filter The filter to walk.
 * @returns The set ordinals, lowest first.
 *
 * @internal
 */
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
