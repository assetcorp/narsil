import { countNumberFacet } from '../../../search/facets'
import { FieldPresence } from '../presence'
import { createNumericStorage } from './storage'
import type { NumericFieldIndex } from './types'

export type { NumericFieldIndex, NumericFieldIndexReader } from './types'

export function createNumericIndex(): NumericFieldIndex {
  const storage = createNumericStorage()
  const present = new FieldPresence(() => storage.regions().ordinals)

  return {
    bytes: () => storage.bytes() + present.bytes(),
    cachedBytes: () => present.bytes(),
    regions: storage.regions,
    insert(ordinal, value) {
      present.invalidate()
      storage.insert(ordinal, value)
    },
    remove(ordinal, value) {
      present.invalidate()
      storage.remove(ordinal, value)
    },
    sortPending: storage.ensureSorted,
    clear() {
      present.invalidate()
      storage.clear()
    },
    deserialize(data) {
      present.invalidate()
      storage.deserialize(data)
    },
    count: () => storage.regions().values.length,
    serialize() {
      const { values, ordinals } = storage.regions()
      return Array.from(values, (value, at) => ({ value, docId: ordinals[at] }))
    },
    getAllDocIdsBitset: capacity => present.regions(capacity),
    facetValueCounts: matched => countNumberFacet(storage.regions(), matched),
  }
}
