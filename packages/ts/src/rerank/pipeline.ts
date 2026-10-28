import { compareCodePoints } from '../core/ordering/code-points'
import type { ResolvedProjection } from '../core/projection'
import { resolveProjection } from '../core/projection'
import { DEFAULT_LIMIT, DEFAULT_OFFSET } from '../engine/constants'
import { ErrorCodes, NarsilError } from '../errors'
import { RESULT_WINDOW } from '../search/constants'
import { decodePageCursor, requireMatchingCursor } from '../search/cursor'
import { requireWithinHybridDepth, resolveHybridFusion } from '../search/fusion'
import { clampRowCount } from '../search/pagination'
import { dedupePinnedEntries, placePinned } from '../search/pinning'
import { pageByPosition } from '../search/position-page'
import type { GroupResult, Hit, QueryResult } from '../types/results'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { resolveRerankParams } from './params'

export interface RerankedQueryIo<T> {
  schema: SchemaDefinition
  maxWindow: number
  binding: string
  clampsPins: boolean
  fusesRankings(request: QueryParams): boolean
  firstStage(params: QueryParams): Promise<QueryResult<T>>
  texts(docIds: string[], fields: string[]): Promise<string[]>
  storedPins(docIds: string[]): Promise<ReadonlySet<string>>
  score(adapter: string, query: string, documents: string[]): Promise<number[]>
  fillDocuments(hits: Array<Hit<T>>, groups: GroupResult[] | undefined, projection: ResolvedProjection): Promise<void>
  highlight?(page: Array<Hit<T>>, projection: ResolvedProjection): void
}

function rerankCursorDepth(cursor: string, binding: string): number {
  const decoded = decodePageCursor(cursor)
  requireMatchingCursor(decoded, cursor, null, true, binding)
  return decoded.depth ?? 0
}

function requireWithinReach(cursorDepth: number, offset: number, limit: number): void {
  const reach = cursorDepth + offset + limit
  if (reach <= RESULT_WINDOW) return
  throw new NarsilError(
    ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
    `The engine pages a reranked query through the first ${RESULT_WINDOW} results, and this page ends at ${reach}`,
    { limit, offset, cursorDepth, window: RESULT_WINDOW },
  )
}

export function reorderByRerank<T>(
  ranked: Array<Hit<T>>,
  windowSize: number,
  scores: readonly number[],
): Array<Hit<T>> {
  let initialLow = Number.POSITIVE_INFINITY
  let initialHigh = Number.NEGATIVE_INFINITY
  let finalLow = Number.POSITIVE_INFINITY
  let finalHigh = Number.NEGATIVE_INFINITY
  const ordered: Array<Hit<T>> = new Array(windowSize)
  for (let i = 0; i < windowSize; i++) {
    const first = ranked[i].score ?? 0
    const score = scores[i]
    if (first < initialLow) initialLow = first
    if (first > initialHigh) initialHigh = first
    if (score < finalLow) finalLow = score
    if (score > finalHigh) finalHigh = score
    ordered[i] = { ...ranked[i], score }
  }
  ordered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || compareCodePoints(a.id, b.id))

  const rescale = initialLow > finalLow
  const scale = rescale ? Math.max(finalHigh - finalLow, 1) / Math.max(initialHigh - initialLow, 1) : 1
  const bias = rescale ? finalLow - initialLow * scale : 0
  for (let i = windowSize; i < ranked.length; i++) {
    const hit = ranked[i]
    ordered.push(rescale ? { ...hit, score: (hit.score ?? 0) * scale + bias } : hit)
  }
  return ordered
}

function firstStageDepth(
  hybridDepth: number | undefined,
  window: number,
  cursorDepth: number,
  offset: number,
  limit: number,
): number {
  if (hybridDepth === undefined) {
    requireWithinReach(cursorDepth, offset, limit)
    return Math.max(window + 1, Math.min(cursorDepth + offset + limit + 1, RESULT_WINDOW))
  }
  requireWithinHybridDepth(cursorDepth, offset, hybridDepth)
  return hybridDepth
}

export async function runRerankedQuery<T>(request: QueryParams, io: RerankedQueryIo<T>): Promise<QueryResult<T>> {
  const fuses = io.fusesRankings(request)
  const hybridDepth = fuses ? resolveHybridFusion(request.hybrid).depth : undefined
  const plan = resolveRerankParams(request, io.schema, io.maxWindow, hybridDepth)
  const limit = clampRowCount(request.limit, DEFAULT_LIMIT)
  const offset = clampRowCount(request.offset, DEFAULT_OFFSET)
  const cursorDepth = request.searchAfter === undefined ? 0 : rerankCursorDepth(request.searchAfter, io.binding)
  const depth = firstStageDepth(hybridDepth, plan.window, cursorDepth, offset, limit)
  const projection = resolveProjection(request.document)

  const { rerank: _rerank, pinned: _pinned, searchAfter: _searchAfter, highlight: _highlight, ...firstParams } = request
  const placesPins = request.searchAfter === undefined && request.pinned !== undefined
  const countsApart = placesPins || (request.vector !== undefined && !fuses)
  const [first, plain] = await Promise.all([
    io.firstStage({ ...firstParams, offset: 0, limit: depth, document: false }),
    countsApart
      ? io.firstStage({
          ...firstParams,
          ...(placesPins ? { pinned: request.pinned } : {}),
          facets: undefined,
          group: undefined,
          offset: cursorDepth + offset,
          limit,
          document: false,
        })
      : undefined,
  ])
  const ranked = first.hits

  let pins = placesPins ? request.pinned : undefined
  if (pins !== undefined) {
    const stored = await io.storedPins(dedupePinnedEntries(pins).map(entry => entry.docId))
    const clamps = io.clampsPins || (first.countExact && ranked.length >= first.count)
    pins = pins.filter(entry => stored.has(entry.docId) && (clamps || entry.position < depth))
  }
  const placedPins = pins
  const place = (hits: Array<Hit<T>>): Array<Hit<T>> =>
    placedPins === undefined
      ? hits
      : placePinned(hits, placedPins, docId => ({ id: docId, score: 0, document: undefined as unknown as T })).hits

  const start = cursorDepth + offset
  const windowSize = Math.min(plan.window, ranked.length)
  const pageHoldsHits = limit > 0 && start < place(ranked).length
  let ordered = ranked
  if (windowSize > 0 && pageHoldsHits) {
    const texts = await io.texts(
      ranked.slice(0, windowSize).map(hit => hit.id),
      plan.fields,
    )
    ordered = reorderByRerank(ranked, windowSize, await io.score(plan.adapter, plan.query, texts))
  } else {
    await io.score(plan.adapter, plan.query, [])
  }

  const pinnedIds = placedPins === undefined ? undefined : new Set(placedPins.map(entry => entry.docId))
  const { page, cursor } = pageByPosition(place(ordered), ordered, { start, limit, pinnedIds, binding: io.binding })

  await io.fillDocuments(page, first.groups, projection)
  if (request.highlight) io.highlight?.(page, projection)

  return {
    hits: page,
    count: (plain ?? first).count,
    countExact: (plain ?? first).countExact,
    elapsed: 0,
    cursor,
    facets: first.facets,
    groups: first.groups,
    coverage: first.coverage,
  }
}
