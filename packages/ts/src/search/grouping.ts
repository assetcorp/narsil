import { groupHits } from '#platform/group-hits'
import { gatheredStoredFields } from '../core/stored-values/gather'
import type { StoredFieldReference } from '../core/stored-values/references'
import {
  compareCodePoints,
  DEFAULT_MAX_PER_GROUP,
  ErrorCodes,
  NarsilError,
  undeclaredFieldOnStrictIndex,
  VECTOR_PATTERN,
} from '../engine/optional-reads-host-bindings'
import type { GroupResult, Hit } from '../types/results'
import type { AnyDocument } from '../types/schema'
import type { GroupConfig } from '../types/search'

export function requireGroupableFields(
  fields: readonly string[],
  flatSchema: Record<string, string>,
  strict: boolean,
): void {
  for (const field of fields) {
    const fieldType = flatSchema[field]
    if (strict && fieldType === undefined) throw undeclaredFieldOnStrictIndex(field, 'group')
    if (fieldType !== undefined && VECTOR_PATTERN.test(fieldType)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine groups hits by a text, number, boolean, enum, or geopoint field, and the schema declares field "${field}" as "${fieldType}"`,
        { field, fieldType },
      )
    }
  }
}

export interface GroupedDocuments {
  fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined
  storedFields(docId: string, fieldPaths: readonly string[]): StoredFieldReference[] | undefined
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

  if (hits.length > 0xffffffff)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The hit count exceeds the group layout')
  const { fields, ordinals } = gatheredStoredFields(
    hits.map(hit => documents.storedFields(hit.id, group.fields)),
    group.fields.length,
  )
  const scores = Float64Array.from(hits, hit => hit.score ?? 0)
  const order = Uint32Array.from(hits, (_, position) => position).sort((left, right) =>
    compareCodePoints(hits[left].id, hits[right].id),
  )
  const idRanks = new Uint32Array(hits.length)
  let rank = 0
  for (let at = 0; at < order.length; at++) {
    if (at > 0 && hits[order[at - 1]].id !== hits[order[at]].id) rank++
    idRanks[order[at]] = rank
  }
  const keptPerGroup = hitsKeptPerGroup(group.maxPerGroup)
  const limit =
    group.limit !== undefined && Number.isFinite(group.limit) && group.limit >= 0
      ? Math.min(Math.floor(group.limit), hits.length)
      : null
  const heads = new Uint32Array(hits.length)
  const offsets = new Uint32Array(hits.length + 1)
  const positions = new Uint32Array(hits.length)
  const members = new Uint32Array(hits.length)
  const found = groupHits(
    fields,
    ordinals,
    scores,
    idRanks,
    group.reduce === undefined ? Math.min(keptPerGroup, hits.length) : hits.length,
    group.reduce === undefined ? limit : null,
    heads,
    offsets,
    positions,
    members,
  )
  if (found < 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The hits cannot be grouped', { status: found })
  const groups: GroupResult[] = []
  for (let at = 0; at < found; at++) {
    const values: Record<string, unknown> = Object.create(null)
    const row = documents.fieldValues(hits[heads[at]].id, group.fields)
    for (let field = 0; field < group.fields.length; field++) values[group.fields[field]] = row?.[field] ?? null
    const everyHit: Hit[] = []
    for (let member = offsets[at]; member < offsets[at + 1]; member++) everyHit.push(hits[positions[member]] as Hit)
    const result: GroupResult = { values, hits: everyHit.slice(0, keptPerGroup) }

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

  if (limit !== null && groups.length > limit) groups.length = limit

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
