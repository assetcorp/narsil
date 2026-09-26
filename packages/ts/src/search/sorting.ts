import {
  type ComparableSortValue,
  compareCodePoints,
  compareComparableKeys,
  defaultSortMode,
  isSortMode,
  readSortField,
  SORT_MODES,
  type SortDirection,
  type SortMode,
  sortModeOf,
  toReducedSortValue,
} from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema, SORTABLE_TEXT_FIELD_TYPE } from '../schema/validator'
import { VECTOR_PATTERN } from '../schema/validator/shared'
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
    return sort.map(entry =>
      entry.mode === undefined
        ? { field: entry.field, direction: entry.direction }
        : { field: entry.field, direction: entry.direction, mode: entry.mode },
    )
  }
  return Object.entries(sort).map(([field, direction]) => ({ field, direction }))
}

export function sortModesOf(fields: readonly SortField[]): SortMode[] {
  return fields.map(sortModeOf)
}

export function sortSignatureEntry(entry: SortField): string[] {
  const mode = sortModeOf(entry)
  return mode === defaultSortMode(entry.direction)
    ? [entry.field, entry.direction]
    : [entry.field, entry.direction, mode]
}

function requireSortMode(entry: SortField, fieldType: string | undefined): void {
  if (entry.mode === undefined) return
  if (!isSortMode(entry.mode)) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      `A sort mode is one of ${SORT_MODES.map(mode => `"${mode}"`).join(', ')}, and the mode on "${entry.field}" is "${String(entry.mode)}"`,
      { field: entry.field, mode: String(entry.mode) },
    )
  }
  const averages = entry.mode === 'avg' || entry.mode === 'median'
  if (averages && fieldType !== undefined && fieldType !== 'number' && fieldType !== 'number[]') {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `The engine applies the "${entry.mode}" mode to a number field alone, and "${entry.field}" is a ${fieldType} field`,
      { field: entry.field, fieldType, mode: entry.mode },
    )
  }
}

export function requireSortableFields(sort: SortSpec | undefined, schema: SchemaDefinition): void {
  const fields = normalizeSort(sort)
  if (fields.length === 0) return

  const flatSchema = flattenSchema(schema)
  for (const entry of fields) {
    const fieldType = flatSchema[entry.field]
    if (entry.direction !== 'asc' && entry.direction !== 'desc') {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_MODE,
        `A sort direction is "asc" or "desc", and the direction on "${entry.field}" is "${String(entry.direction)}"`,
        { field: entry.field, direction: String(entry.direction) },
      )
    }
    requireSortMode(entry, fieldType)
    if (fieldType === 'string') {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine sorts by text field "${entry.field}" only where the schema declares it "${SORTABLE_TEXT_FIELD_TYPE}", because ordering text takes far more memory per document than ordering a number`,
        { field: entry.field, fieldType },
      )
    }
    if (fieldType === 'geopoint' || (fieldType !== undefined && VECTOR_PATTERN.test(fieldType))) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine sorts by a number, boolean, enum, or sortable text field, and "${entry.field}" is a ${fieldType} field`,
        { field: entry.field, fieldType },
      )
    }
  }
}

export function readFieldValue(obj: AnyDocument, path: string): unknown {
  return readSortField(obj, path)
}

export function readSortValues(
  document: AnyDocument | undefined,
  fields: readonly string[],
  modes: readonly SortMode[],
): ComparableSortValue[] {
  if (!document) return fields.map(() => null)
  return fields.map((field, index) => toReducedSortValue(readSortField(document, field), modes[index] ?? 'min'))
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
