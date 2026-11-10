import type { DocumentStoreReader } from '../core/document-store'

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

const UNRESOLVED_ORDINAL = -1
const NO_VECTOR_MARK = -2

export interface VectorOrdinalMap {
  readonly header: Int32Array
  readonly layoutGeneration: number
  readonly numberingGeneration: number
  ordinals: Int32Array
}

export interface VectorOrdinalMaps {
  bytes: number
  readonly byField: Map<string, VectorOrdinalMap>
}

export interface FilterSubsetOwner {
  readonly docStore: DocumentStoreReader
  vectorOrdinalMaps: VectorOrdinalMaps | null
}

export interface FilterSubset {
  readonly owner: FilterSubsetOwner
  readonly bits: Uint32Array
  readonly numberingGeneration: number
}

export interface OrdinalSpace {
  readonly fieldName: string
  readonly slots: number
  readonly header: Int32Array
  readonly layoutGeneration: number
  ordinalOf(docId: string): number | undefined
  holdsCurrentOrdinal(ordinal: number): boolean
  isRemoved(ordinal: number): boolean
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

function freshOrdinals(length: number): Int32Array {
  return new Int32Array(length).fill(UNRESOLVED_ORDINAL)
}

function mapsOf(owner: FilterSubsetOwner): VectorOrdinalMaps {
  owner.vectorOrdinalMaps ??= { bytes: 0, byField: new Map() }
  return owner.vectorOrdinalMaps
}

function mapFor(
  maps: VectorOrdinalMaps,
  docStore: DocumentStoreReader,
  space: OrdinalSpace,
  numberingGeneration: number,
): VectorOrdinalMap {
  const held = maps.byField.get(space.fieldName)
  if (
    held !== undefined &&
    held.header === space.header &&
    held.layoutGeneration === space.layoutGeneration &&
    held.numberingGeneration === numberingGeneration
  ) {
    return held
  }
  const map: VectorOrdinalMap = {
    header: space.header,
    layoutGeneration: space.layoutGeneration,
    numberingGeneration,
    ordinals: freshOrdinals(docStore.internalIdCapacity()),
  }
  maps.bytes += map.ordinals.byteLength - (held?.ordinals.byteLength ?? 0)
  maps.byField.set(space.fieldName, map)
  return map
}

function growTo(maps: VectorOrdinalMaps, map: VectorOrdinalMap, length: number): void {
  const grown = freshOrdinals(Math.max(length, map.ordinals.length * 2))
  grown.set(map.ordinals)
  maps.bytes += grown.byteLength - map.ordinals.byteLength
  map.ordinals = grown
}

function ordinalAt(
  maps: VectorOrdinalMaps,
  map: VectorOrdinalMap,
  internalId: number,
  docStore: DocumentStoreReader,
  space: OrdinalSpace,
): number {
  if (internalId >= map.ordinals.length) growTo(maps, map, internalId + 1)
  const held = map.ordinals[internalId]
  if (held >= 0 && space.holdsCurrentOrdinal(held)) return held
  if (held <= NO_VECTOR_MARK && NO_VECTOR_MARK - held === space.slots) return UNRESOLVED_ORDINAL
  const docId = docStore.getExternalId(internalId)
  const resolved = docId === undefined ? undefined : space.ordinalOf(docId)
  map.ordinals[internalId] = resolved ?? NO_VECTOR_MARK - space.slots
  return resolved ?? UNRESOLVED_ORDINAL
}

export function ordinalFilterForSubsets(subsets: readonly FilterSubset[], space: OrdinalSpace): OrdinalFilter {
  const filter = createOrdinalFilter(space.slots)
  for (const subset of subsets) {
    const docStore = subset.owner.docStore
    if (docStore.numberingGeneration() !== subset.numberingGeneration) continue
    const resolver = docStore.resolver()
    const maps = mapsOf(subset.owner)
    const map = mapFor(maps, docStore, space, subset.numberingGeneration)
    const bits = subset.bits
    for (let wordIndex = 0; wordIndex < bits.length; wordIndex++) {
      let word = bits[wordIndex]
      if (word === 0) continue
      const base = wordIndex << 5
      while (word !== 0) {
        const internalId = base + (Math.clz32(word & -word) ^ 31)
        word &= word - 1
        if (!resolver.isLive(internalId)) continue
        const ordinal = ordinalAt(maps, map, internalId, docStore, space)
        if (ordinal < 0 || space.isRemoved(ordinal)) continue
        addToOrdinalFilter(filter, ordinal)
      }
    }
  }
  return filter
}
