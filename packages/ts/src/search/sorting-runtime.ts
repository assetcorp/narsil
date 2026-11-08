import { type ComparableSortValue, compareCodePoints, isSortMode, SORT_MODES } from '../core/ordering'
import { SORT_VALUE_MAX_CODE_POINTS } from '../core/ordering/constants'
import { compareComparableKeys } from '../core/ordering/sort-comparison'
import { ErrorCodes, NarsilError } from '../errors'
import { undeclaredFieldOnStrictIndex } from '../filters/operands'
import { flattenSchema } from '../schema/validator'
import { isStringValuedBase, parsedTypeOf, withSortableOption } from '../schema/validator/field-type'
import { isGeopointOrVectorType } from '../schema/validator/shared'
import type { Hit } from '../types/results'
import type { AnyDocument, SchemaDefinition } from '../types/schema'
import type { SortField, SortSpec } from '../types/search'
import { normalizeSort } from './sorting'

export { buildSortOrder, reduceSortValue, reduceStoredSortValue, sortSelect, textRange } from '#platform/sort-value'
export { compositeSortedPage } from '../core/partition/composite/sorted-page'
export { applyPartitionFilters, applyPartitionFiltersBitset, partitionFilterMatches } from '../core/partition/filters'
export { createSortColumnSet } from '../core/partition/sort-columns'
export { selectTextRange } from '../core/partition/sort-columns/range'
export { selectSortedPage } from '../core/partition/sort-columns/select'
export { executeSortedQueryPage, sortsWithoutScores } from '../engine/query/sorted'
export { validatedFilterOf } from '../filters/operands'

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

export function requireSortableFields(sort: SortSpec | undefined, schema: SchemaDefinition, strict = false): void {
  const fields = normalizeSort(sort)
  if (fields.length === 0) return

  const flatSchema = flattenSchema(schema)
  for (const entry of fields) {
    const fieldType = flatSchema[entry.field]
    if (strict && fieldType === undefined) throw undeclaredFieldOnStrictIndex(entry.field, 'sort')
    if (entry.direction !== 'asc' && entry.direction !== 'desc') {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_MODE,
        `A sort direction is "asc" or "desc", and the direction on "${entry.field}" is "${String(entry.direction)}"`,
        { field: entry.field, direction: String(entry.direction) },
      )
    }
    requireSortMode(entry, fieldType)
    const parsed = parsedTypeOf(fieldType)
    if (parsed !== undefined && isStringValuedBase(parsed.base) && !parsed.sortable) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine sorts by text field "${entry.field}" only where its type includes "sortable", as in "${withSortableOption(parsed)}", because it keeps up to the first ${SORT_VALUE_MAX_CODE_POINTS} code points of every document's value in memory to sort by a text field`,
        { field: entry.field, fieldType },
      )
    }
    if (isGeopointOrVectorType(fieldType)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine sorts by a number, boolean, enum, or sortable text field, and "${entry.field}" is a ${fieldType} field`,
        { field: entry.field, fieldType },
      )
    }
  }
}

export function applySorting<T = AnyDocument>(
  hits: Array<Hit<T>>,
  sort: SortSpec,
  sortKeyOf: (docId: string) => readonly ComparableSortValue[],
): Array<Hit<T>> {
  const normalized = normalizeSort(sort)
  if (normalized.length === 0) return hits
  const directions = normalized.map(entry => entry.direction)
  const keyCache = new Map<string, readonly ComparableSortValue[]>()
  for (const hit of hits) keyCache.set(hit.id, sortKeyOf(hit.id))
  return hits
    .slice()
    .sort(
      (left, right) =>
        compareComparableKeys(keyCache.get(left.id) ?? [], keyCache.get(right.id) ?? [], directions) ||
        compareCodePoints(left.id, right.id),
    )
}
