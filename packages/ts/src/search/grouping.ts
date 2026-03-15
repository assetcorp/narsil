import type { GroupResult, Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { GroupConfig } from '../types/search'

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

export function applyGrouping<T = AnyDocument>(
  hits: Array<Hit<T>>,
  group: GroupConfig,
  getDocument: (docId: string) => AnyDocument | undefined,
): GroupResult[] {
  if (!group.fields || group.fields.length === 0) {
    return [{ values: {}, hits: hits as Array<Hit> }]
  }

  const groupMap = new Map<string, { values: Record<string, unknown>; hits: Array<Hit<T>> }>()

  for (const hit of hits) {
    const doc = getDocument(hit.id)
    const fieldValues: unknown[] = []
    const valuesRecord: Record<string, unknown> = {}

    for (const field of group.fields) {
      const value = doc ? getNestedValue(doc, field) : undefined
      fieldValues.push(value)
      valuesRecord[field] = value
    }

    const compositeKey = JSON.stringify(fieldValues)
    const existing = groupMap.get(compositeKey)

    if (existing) {
      existing.hits.push(hit)
    } else {
      groupMap.set(compositeKey, { values: valuesRecord, hits: [hit] })
    }
  }

  const groups: GroupResult[] = []

  for (const entry of groupMap.values()) {
    let groupHits = entry.hits as Array<Hit>

    if (group.maxPerGroup !== undefined && group.maxPerGroup > 0) {
      groupHits = groupHits.slice(0, group.maxPerGroup)
    }

    const result: GroupResult = { values: entry.values, hits: groupHits }

    if (group.reduce) {
      try {
        let accumulator = group.reduce.initialValue()
        for (const hit of groupHits) {
          const doc = getDocument(hit.id)
          if (doc) {
            accumulator = group.reduce.reducer(accumulator, doc, hit.score)
          }
        }
        ;(result as GroupResult & { reduced: unknown }).reduced = accumulator
      } catch (err) {
        ;(result as GroupResult & { reducerError: string }).reducerError =
          err instanceof Error ? err.message : String(err)
      }
    }

    groups.push(result)
  }

  groups.sort((a, b) => {
    const aScore = a.hits.length > 0 ? a.hits[0].score : 0
    const bScore = b.hits.length > 0 ? b.hits[0].score : 0
    return bScore - aScore
  })

  return groups
}
