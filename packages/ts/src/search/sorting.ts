import type { Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'

export type SortDirection = 'asc' | 'desc'

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

export function compareSortValues(
  aValues: readonly unknown[],
  bValues: readonly unknown[],
  directions: readonly SortDirection[],
  collator: Intl.Collator,
): number {
  for (let i = 0; i < directions.length; i++) {
    const aVal = aValues[i]
    const bVal = bValues[i]

    const aIsNullish = aVal === undefined || aVal === null
    const bIsNullish = bVal === undefined || bVal === null

    if (aIsNullish && bIsNullish) continue
    if (aIsNullish) return 1
    if (bIsNullish) return -1

    let comparison = 0

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      comparison = collator.compare(aVal, bVal)
    } else if (typeof aVal === 'number' && typeof bVal === 'number') {
      const aIsNaN = Number.isNaN(aVal)
      const bIsNaN = Number.isNaN(bVal)
      if (aIsNaN && bIsNaN) continue
      if (aIsNaN) return 1
      if (bIsNaN) return -1
      comparison = aVal - bVal
    } else if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
      comparison = aVal === bVal ? 0 : aVal ? 1 : -1
    }

    if (comparison !== 0) {
      return directions[i] === 'desc' ? -comparison : comparison
    }
  }

  return 0
}

export function applySorting<T = AnyDocument>(
  hits: Array<Hit<T>>,
  sort: Record<string, SortDirection>,
  getDocument: (docId: string) => AnyDocument | undefined,
): Array<Hit<T>> {
  const sortFields = Object.keys(sort)
  if (sortFields.length === 0) return hits

  const directions = sortFields.map(field => sort[field])
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
  const valueCache = new Map<string, unknown[]>()

  for (const hit of hits) {
    valueCache.set(hit.id, readSortValues(getDocument(hit.id), sortFields))
  }

  const sorted = hits.slice()
  sorted.sort((a, b) => compareSortValues(valueCache.get(a.id) ?? [], valueCache.get(b.id) ?? [], directions, collator))

  return sorted
}
