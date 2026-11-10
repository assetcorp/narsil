import { textRangeFieldsOf } from '../filters/text-range'
import { flattenSchema } from '../schema/validator/schema'
import { loadedMessagePack, loadMessagePack } from '../serialization/msgpack-code'
import type { FilterExpression } from '../types/filters'
import type { IndexConfig } from '../types/schema'
import type { QueryParams, SortSpec } from '../types/search'

const OBJECT_FIELD_TYPE = /^(?:geopoint|vector\[)/

interface StoredValueReads {
  sort?: SortSpec
  filters?: FilterExpression
  facets?: QueryParams['facets']
  group?: QueryParams['group']
}

function sortFieldsOf(sort: SortSpec | undefined): unknown[] {
  if (sort === undefined || sort === null) return []
  if (Array.isArray(sort)) return sort.map(entry => (entry === null || typeof entry !== 'object' ? entry : entry.field))
  return Object.keys(sort)
}

function storedValueFieldsOf(reads: StoredValueReads): unknown[] | null {
  try {
    const textRangeFields = textRangeFieldsOf(reads.filters)
    if (textRangeFields === null) return null
    const fields: unknown[] = [...sortFieldsOf(reads.sort), ...textRangeFields]
    const facets = reads.facets
    if (facets !== undefined && facets !== null) fields.push(...Object.keys(facets))
    const groupFields = reads.group?.fields
    if (groupFields !== undefined) {
      if (!Array.isArray(groupFields)) return null
      fields.push(...groupFields)
    }
    return fields
  } catch {
    return null
  }
}

function mayHoldObject(field: unknown, flat: Readonly<Record<string, string>>, strict: boolean): boolean {
  if (typeof field !== 'string') return true
  const fieldType = flat[field]
  return fieldType === undefined ? !strict : OBJECT_FIELD_TYPE.test(fieldType)
}

export function loadMessagePackForStoredValues(reads: StoredValueReads, config: IndexConfig): Promise<unknown> | null {
  if (loadedMessagePack() !== null) return null
  if (
    reads.sort === undefined &&
    reads.facets === undefined &&
    reads.group === undefined &&
    reads.filters === undefined
  )
    return null
  const fields = storedValueFieldsOf(reads)
  if (fields === null) return loadMessagePack()
  if (fields.length === 0) return null
  const flat = flattenSchema(config.schema)
  const strict = config.strict === true
  for (const field of fields) if (mayHoldObject(field, flat, strict)) return loadMessagePack()
  return null
}
