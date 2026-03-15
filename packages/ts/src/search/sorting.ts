import type { Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'

function getNestedValue(obj: AnyDocument, path: string): unknown {
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

export function applySorting<T = AnyDocument>(
  hits: Array<Hit<T>>,
  sort: Record<string, 'asc' | 'desc'>,
  getDocument: (docId: string) => AnyDocument | undefined,
): Array<Hit<T>> {
  const sortFields = Object.entries(sort)
  if (sortFields.length === 0) return hits

  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
  const valueCache = new Map<string, unknown[]>()

  for (const hit of hits) {
    const doc = getDocument(hit.id)
    if (!doc) {
      valueCache.set(
        hit.id,
        sortFields.map(() => undefined),
      )
      continue
    }
    const values = sortFields.map(([field]) => getNestedValue(doc, field))
    valueCache.set(hit.id, values)
  }

  const sorted = hits.slice()
  sorted.sort((a, b) => {
    const aValues = valueCache.get(a.id) ?? []
    const bValues = valueCache.get(b.id) ?? []

    for (let i = 0; i < sortFields.length; i++) {
      const direction = sortFields[i][1]
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
        return direction === 'desc' ? -comparison : comparison
      }
    }

    return 0
  })

  return sorted
}
