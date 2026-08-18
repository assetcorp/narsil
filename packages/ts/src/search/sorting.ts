import {
  type ComparableSortValue,
  compareCodePoints,
  compareComparableKeys,
  readSortField,
  type SortDirection,
} from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema, SORTABLE_TEXT_FIELD_TYPE } from '../schema/validator'
import type { Hit } from '../types/results'
import type { AnyDocument, SchemaDefinition } from '../types/schema'
import type { SortField, SortSpec } from '../types/search'

export type { SortDirection } from '../core/ordering'
export { compareSortValues } from '../core/ordering'

function isFieldList(sort: SortSpec): sort is readonly SortField[] {
  return Array.isArray(sort)
}

export function normalizeSort(sort: SortSpec | undefined): SortField[] {
  if (sort === undefined) return []
  if (isFieldList(sort)) {
    return sort.map(entry => ({ field: entry.field, direction: entry.direction }))
  }
  return Object.entries(sort).map(([field, direction]) => ({ field, direction }))
}

export function requireSortableFields(sort: SortSpec | undefined, schema: SchemaDefinition): void {
  const fields = normalizeSort(sort)
  if (fields.length === 0) return

  const flatSchema = flattenSchema(schema)
  for (const entry of fields) {
    if (flatSchema[entry.field] !== 'string') continue
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `A sort names text field "${entry.field}" only where the schema declares it "${SORTABLE_TEXT_FIELD_TYPE}", because ordering text costs far more memory per document than ordering a number`,
      { field: entry.field, fieldType: 'string' },
    )
  }
}

export function readFieldValue(obj: AnyDocument, path: string): unknown {
  return readSortField(obj, path)
}

export function readSortValues(document: AnyDocument | undefined, fields: readonly string[]): unknown[] {
  if (!document) return fields.map(() => undefined)
  return fields.map(field => readFieldValue(document, field))
}

export function applySorting<T = AnyDocument>(
  hits: Array<Hit<T>>,
  sort: SortSpec,
  sortKeyOf: (docId: string) => readonly ComparableSortValue[],
): Array<Hit<T>> {
  const normalized = normalizeSort(sort)
  if (normalized.length === 0) return hits

  const directions: SortDirection[] = normalized.map(entry => entry.direction)
  const keyCache = new Map<string, readonly ComparableSortValue[]>()

  for (const hit of hits) {
    keyCache.set(hit.id, sortKeyOf(hit.id))
  }

  const sorted = hits.slice()
  sorted.sort(
    (a, b) =>
      compareComparableKeys(keyCache.get(a.id) ?? [], keyCache.get(b.id) ?? [], directions) ||
      compareCodePoints(a.id, b.id),
  )

  return sorted
}
