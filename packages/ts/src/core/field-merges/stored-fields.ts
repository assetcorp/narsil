import { mergeStoredFieldRegions } from '#platform/stored-field-merges'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { DocumentStoreReader } from '../document-store'
import { cachedStoredFields, type StoredFieldRegions, storedValuesOf } from '../stored-values/columns'

export interface StoredFieldSource {
  store: DocumentStoreReader
  mapping: Uint32Array
}

export function mergeStoredFields(sources: readonly StoredFieldSource[], count: number): StoredFieldRegions[] {
  const fields = new Set<string>()
  for (const { store } of sources) for (const { field } of cachedStoredFields(store)) fields.add(field)
  return Array.from(fields, field => {
    const inputs = sources.map(({ store, mapping }) => {
      const values = storedValuesOf(store, field)
      return {
        mapping,
        regions: [
          values.shapes,
          values.starts,
          values.kinds,
          values.numbers,
          values.textStart,
          values.textLength,
          values.units,
          values.bytes,
        ],
      }
    })
    const regions = mergeStoredFieldRegions(inputs, count)
    const values: NativeStoredValues = {
      shapes: regions[0] as Uint8Array,
      starts: regions[1] as Uint32Array,
      kinds: regions[2] as Uint8Array,
      numbers: regions[3] as Float64Array,
      textStart: regions[4] as Uint32Array,
      textLength: regions[5] as Uint32Array,
      units: regions[6] as Uint16Array,
      bytes: regions[7] as Uint8Array,
    }
    return { field, values }
  })
}
