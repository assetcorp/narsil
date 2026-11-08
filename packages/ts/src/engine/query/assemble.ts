import type { ResolvedAnalysis } from '../../analysis/registry'
import type { ComparableSortValue } from '../../core/ordering'
import { projectionKeepsField, type ResolvedProjection } from '../../core/projection'
import type { SynonymLookup } from '../../core/synonyms/types'
import type { FanOutResult } from '../../partitioning/fan-out'
import type { HitReads } from '../../partitioning/manager/state-pins'
import { flattenSchema } from '../../schema/validator'
import type { CursorBinding } from '../../search/cursor-binding'
import { applyGrouping } from '../../search/grouping-code'
import { applyPagination, type PaginationSortContext } from '../../search/pagination'
import { placePinned } from '../../search/pinning-code'
import { sortModesOf } from '../../search/sorting'
import { applySorting } from '../../search/sorting-code'
import type { ScoredDocument } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { FacetResult, GroupResult, Hit } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { QueryParams, SortField } from '../../types/search'
import { applyHighlights } from './highlight'

export interface PageRequest {
  readonly limit: number
  readonly offset: number
  readonly sortFields: readonly SortField[]
  readonly sortSignature: string | null
  readonly projection: ResolvedProjection
  readonly placesPinned: boolean
}

export interface RankedPage<T> {
  paginated: Array<Hit<T>>
  nextCursor: string | undefined
  count: number
  countExact: boolean
  facets: Record<string, FacetResult> | undefined
  groups: GroupResult[] | undefined
}

export interface HighlightSettings {
  readonly language: LanguageModule
  readonly analysis: ResolvedAnalysis
  readonly schema: SchemaDefinition
  readonly synonyms: SynonymLookup | null
}

export interface RankedFanOut extends FanOutResult {
  paginate?: typeof applyPagination
}

export function needsEveryHit(params: QueryParams): boolean {
  return (
    params.sort !== undefined ||
    params.group !== undefined ||
    params.pinned !== undefined ||
    params.searchAfter !== undefined
  )
}

function hitOf<T>(scored: ScoredDocument, params: QueryParams): Hit<T> {
  return {
    id: scored.docId,
    score: scored.score,
    document: undefined as unknown as T,
    scoreComponents: params.includeScoreComponents
      ? { termFrequencies: scored.termFrequencies, fieldLengths: scored.fieldLengths, idf: scored.idf }
      : undefined,
  }
}

function hitsOf<T>(fanOutResult: FanOutResult, params: QueryParams, page: PageRequest): Array<Hit<T>> {
  if (needsEveryHit(params)) return fanOutResult.scored.map(scored => hitOf<T>(scored, params))
  const end = Math.min(page.offset + page.limit + 1, fanOutResult.scored.length)
  const hits: Array<Hit<T>> = new Array(end)
  for (let i = 0; i < end; i++) hits[i] = hitOf<T>(fanOutResult.scored[i], params)
  return hits
}

export function rankPage<T>(
  fanOutResult: RankedFanOut,
  params: QueryParams,
  page: PageRequest,
  schema: SchemaDefinition,
  cursorBinding: CursorBinding,
  reads: HitReads,
): RankedPage<T> {
  let hits = hitsOf<T>(fanOutResult, params, page)
  const sortFieldNames = page.sortFields.map(entry => entry.field)
  const sortFlatSchema = sortFieldNames.length === 0 ? {} : flattenSchema(schema)
  const sortFieldTypes = sortFieldNames.map(field => sortFlatSchema[field])
  const sortModes = sortModesOf(page.sortFields)
  const sortKeyCache = new Map<string, readonly ComparableSortValue[]>()
  const sortKeyOf = (docId: string): readonly ComparableSortValue[] => {
    let key = sortKeyCache.get(docId)
    if (key === undefined) {
      key = reads.sortValues(docId, sortFieldNames, sortFieldTypes, sortModes)
      sortKeyCache.set(docId, key)
    }
    return key
  }

  if (params.sort) hits = applySorting(hits, params.sort, sortKeyOf)

  let groups: GroupResult[] | undefined
  if (params.group) {
    groups = applyGrouping(hits, params.group, {
      fieldValues: (docId, fieldPaths) => reads.fieldValues(docId, fieldPaths),
      storedFields: (docId, fieldPaths) => reads.storedFields(docId, fieldPaths),
      document: docId => reads.getRef(docId),
    })
  }

  let pinsFromOutside = 0
  if (params.pinned && params.searchAfter === undefined && page.placesPinned) {
    const placement = placePinned(hits, params.pinned, (docId: string) => {
      const doc = reads.getRef(docId)
      if (!doc) return undefined
      return { id: docId, score: 0, document: doc as T }
    })
    hits = placement.hits
    pinsFromOutside = placement.placedFromOutside
  }

  let sortContext: PaginationSortContext | undefined
  if (page.sortSignature !== null) {
    sortContext = {
      signature: page.sortSignature,
      directions: page.sortFields.map(entry => entry.direction),
      sortKeyOf,
    }
  }

  const pinnedIds =
    params.pinned !== undefined && params.searchAfter === undefined
      ? new Set(params.pinned.map(entry => entry.docId))
      : undefined
  const paged = (fanOutResult.paginate ?? applyPagination)(
    hits,
    page.limit,
    page.offset,
    cursorBinding,
    params.searchAfter,
    sortContext,
    pinnedIds,
  )
  const holdsEveryMatch =
    fanOutResult.matchedExact !== false && fanOutResult.scored.length === fanOutResult.totalMatched

  if (page.sortSignature !== null && params.includeScores !== true) {
    for (const hit of hits) hit.score = undefined
  }

  return {
    paginated: paged.paginated,
    nextCursor: paged.nextCursor,
    count: fanOutResult.totalMatched + (holdsEveryMatch ? pinsFromOutside : 0),
    countExact: fanOutResult.matchedExact !== false && (holdsEveryMatch || pinsFromOutside === 0),
    facets: fanOutResult.facets,
    groups,
  }
}

export function fillHits<T>(
  paginated: Array<Hit<T>>,
  groups: GroupResult[] | undefined,
  params: QueryParams,
  projection: ResolvedProjection,
  reads: HitReads,
  highlighting: HighlightSettings,
): void {
  for (const hit of paginated) {
    hit.document = (projection.kind === 'none' ? {} : (reads.get(hit.id, projection) ?? {})) as T
  }
  if (groups) {
    for (const group of groups) {
      for (const hit of group.hits) {
        hit.document = projection.kind === 'none' ? {} : (reads.get(hit.id, projection) ?? {})
      }
    }
  }
  if (!params.highlight) return
  const dropped = params.highlight.fields.some(field => !projectionKeepsField(projection, field))
  const readStoredDocument = dropped
    ? (docId: string): Record<string, unknown> | undefined => reads.get(docId, { kind: 'full' })
    : undefined
  const { language, analysis, schema, synonyms } = highlighting
  applyHighlights(paginated, params, language, analysis, schema, readStoredDocument, synonyms)
}
