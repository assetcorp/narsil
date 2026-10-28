import { createDocumentStore } from '../../core/document-store'
import type { FilterSubset } from '../../vector/filter-ordinals'

export function filterSubsetsForDocIds(docIds: Iterable<string>): FilterSubset[] {
  const docStore = createDocumentStore()
  const internalIds: number[] = []
  for (const docId of docIds) internalIds.push(docStore.ensureInternalId(docId))
  const bits = new Uint32Array(Math.ceil(docStore.internalIdCapacity() / 32))
  for (const internalId of internalIds) bits[internalId >>> 5] |= 1 << (internalId & 31)
  return [{ owner: { docStore, vectorOrdinalMaps: null }, bits, numberingGeneration: docStore.numberingGeneration() }]
}
