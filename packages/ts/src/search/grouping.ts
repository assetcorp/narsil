import { compareCodePoints } from '../core/ordering'
import type { GroupResult, Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { GroupConfig } from '../types/search'
import { DEFAULT_MAX_PER_GROUP } from './constants'

export interface GroupedDocuments {
  fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined
  document(docId: string): AnyDocument | undefined
}

export function hitsKeptPerGroup(maxPerGroup: number | undefined): number {
  if (maxPerGroup === undefined || !Number.isFinite(maxPerGroup) || maxPerGroup < 1) return DEFAULT_MAX_PER_GROUP
  return Math.floor(maxPerGroup)
}

export function applyGrouping<T = AnyDocument>(
  hits: Array<Hit<T>>,
  group: GroupConfig,
  documents: GroupedDocuments,
): GroupResult[] {
  if (!group.fields || group.fields.length === 0) {
    return [{ values: {}, hits: hits as Array<Hit> }]
  }

  const groupMap = new Map<string, { values: Record<string, unknown>; hits: Array<Hit<T>> }>()

  for (const hit of hits) {
    const stored = documents.fieldValues(hit.id, group.fields)
    const fieldValues: unknown[] = []
    const valuesRecord: Record<string, unknown> = {}

    for (let at = 0; at < group.fields.length; at++) {
      const value = stored?.[at]
      fieldValues.push(value)
      valuesRecord[group.fields[at]] = value
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

  const keptPerGroup = hitsKeptPerGroup(group.maxPerGroup)

  for (const entry of groupMap.values()) {
    const everyHit = entry.hits as Array<Hit>
    const result: GroupResult = { values: entry.values, hits: everyHit.slice(0, keptPerGroup) }

    if (group.reduce) {
      const folded = foldGroupReducer(
        group.reduce,
        everyHit.map(hit => ({ document: documents.document(hit.id), score: hit.score ?? 0 })),
      )
      if (folded.reducerError !== undefined) {
        result.reducerError = folded.reducerError
      } else {
        result.reduced = folded.reduced
      }
    }

    groups.push(result)
  }

  groups.sort((a, b) => {
    const aScore = a.hits.length > 0 ? (a.hits[0].score ?? 0) : 0
    const bScore = b.hits.length > 0 ? (b.hits[0].score ?? 0) : 0
    if (aScore !== bScore) return bScore - aScore
    const aId = a.hits.length > 0 ? a.hits[0].id : ''
    const bId = b.hits.length > 0 ? b.hits[0].id : ''
    return compareCodePoints(aId, bId)
  })

  if (group.limit !== undefined && Number.isFinite(group.limit) && group.limit >= 0) {
    const cap = Math.floor(group.limit)
    if (groups.length > cap) {
      groups.length = cap
    }
  }

  return groups
}

/**
 * Folds a group reducer over one group's kept rows, skipping a row whose
 * document is missing, and captures a thrown reducer error as a message in
 * place of failing the query. The engine folds its own groups through this,
 * and the cluster coordinator folds merged groups through it too, so the two
 * paths reduce identically.
 *
 * @param reduce - The caller's reducer and its initial value.
 * @param rows - One row per kept hit: its document, or undefined where the store lacks it, and its score.
 * @returns The accumulated value, or the error message the reducer threw.
 */
export function foldGroupReducer(
  reduce: NonNullable<GroupConfig['reduce']>,
  rows: Array<{ document: AnyDocument | undefined; score: number }>,
): { reduced?: unknown; reducerError?: string } {
  try {
    let accumulator = reduce.initialValue()
    for (const row of rows) {
      if (row.document !== undefined) {
        accumulator = reduce.reducer(accumulator, row.document, row.score)
      }
    }
    return { reduced: accumulator }
  } catch (err) {
    return { reducerError: err instanceof Error ? err.message : String(err) }
  }
}
