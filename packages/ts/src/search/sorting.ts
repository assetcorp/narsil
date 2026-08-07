import { compareCodePoints, compareSortValues, type SortDirection } from '../core/ordering'
import type { Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'
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

export function readFieldValue(obj: AnyDocument, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = obj
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    if (!Object.hasOwn(current as Record<string, unknown>, segment)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function readSortValues(document: AnyDocument | undefined, fields: readonly string[]): unknown[] {
  if (!document) return fields.map(() => undefined)
  return fields.map(field => readFieldValue(document, field))
}

export function applySorting<T = AnyDocument>(
  hits: Array<Hit<T>>,
  sort: SortSpec,
  getDocument: (docId: string) => AnyDocument | undefined,
): Array<Hit<T>> {
  const normalized = normalizeSort(sort)
  if (normalized.length === 0) return hits

  const sortFields = normalized.map(entry => entry.field)
  const directions: SortDirection[] = normalized.map(entry => entry.direction)
  const valueCache = new Map<string, unknown[]>()

  for (const hit of hits) {
    valueCache.set(hit.id, readSortValues(getDocument(hit.id), sortFields))
  }

  const sorted = hits.slice()
  sorted.sort(
    (a, b) =>
      compareSortValues(valueCache.get(a.id) ?? [], valueCache.get(b.id) ?? [], directions) ||
      compareCodePoints(a.id, b.id),
  )

  return sorted
}
