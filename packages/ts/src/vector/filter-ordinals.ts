import type { DocumentStoreReader } from '../core/document-store'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter } from './ordinal-filter'

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
