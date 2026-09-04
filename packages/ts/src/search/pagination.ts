import { compareCodePoints, compareSortValues, type SortDirection, toComparableSortValue } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { RESULT_WINDOW } from './constants'
import { decodePageCursor, encodePageCursor, type PageCursor, requireMatchingCursor } from './cursor'

export function clampRowCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

export function requireWithinResultWindow(limit: number, offset: number): void {
  const depth = offset + limit
  if (depth <= RESULT_WINDOW) return
  throw new NarsilError(
    ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
    `A request reaches the first ${RESULT_WINDOW} results, and offset + limit is ${depth}. Page past that with the cursor each result carries`,
    { limit, offset, window: RESULT_WINDOW },
  )
}

function lastOrganicResult<T extends { id: string }>(sliced: T[], pinnedIds?: ReadonlySet<string>): T | undefined {
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (pinnedIds === undefined || !pinnedIds.has(sliced[i].id)) return sliced[i]
  }
  return undefined
}

export interface PaginationSortContext {
  signature: string
  directions: readonly SortDirection[]
  sortKeyOf(docId: string): readonly unknown[]
}

function ordersAfterAnchor<T extends { id: string; score?: number }>(
  result: T,
  anchor: PageCursor,
  sort: PaginationSortContext | undefined,
): boolean {
  if (sort !== undefined && anchor.sortKey !== null) {
    const comparison =
      compareSortValues(sort.sortKeyOf(result.id), anchor.sortKey, sort.directions) ||
      compareCodePoints(result.id, anchor.anchor)
    return comparison > 0
  }
  if (anchor.score === null) return true
  if (result.score === undefined) return true
  if (result.score < anchor.score) return true
  return result.score === anchor.score && compareCodePoints(result.id, anchor.anchor) > 0
}

/**
 * Slices one page out of a ranked result list and encodes the cursor the next
 * page seeks from. A cursor request first validates against the request's sort
 * signature and binding, then the page starts after the anchor. The cursor
 * anchors on the last result of the page that is not a pinned placement, and a
 * page holding only placements returns no cursor.
 *
 * @param results - The ranked results, pinned placements included.
 * @param limit - The page size.
 * @param offset - The count of results the page skips.
 * @param binding - The request's cursor binding.
 * @param cursor - The cursor the request carried, or undefined for a first page.
 * @param sort - The sort signature, directions, and key reader of a sorted request.
 * @param pinnedIds - The ids of the placements on this page, or undefined when none were placed.
 * @returns The page and, where more results follow, the cursor to them.
 */
export function applyPagination<T extends { id: string; score?: number }>(
  results: T[],
  limit: number,
  offset: number,
  binding: string,
  cursor?: string,
  sort?: PaginationSortContext,
  pinnedIds?: ReadonlySet<string>,
): { paginated: T[]; nextCursor?: string } {
  const decoded = cursor ? decodePageCursor(cursor) : null
  if (decoded !== null && cursor !== undefined) {
    requireMatchingCursor(decoded, cursor, sort?.signature ?? null, true, binding)
  }

  if (limit <= 0) {
    return { paginated: [] }
  }

  let startIndex = 0

  if (decoded !== null) {
    startIndex = results.length
    for (let i = 0; i < results.length; i++) {
      if (ordersAfterAnchor(results[i], decoded, sort)) {
        startIndex = i
        break
      }
    }
  }

  const afterOffset = startIndex + offset
  const sliced = results.slice(afterOffset, afterOffset + limit)

  let nextCursor: string | undefined

  const hasMore = afterOffset + limit < results.length
  const lastResult = lastOrganicResult(sliced, pinnedIds)
  if (hasMore && lastResult !== undefined) {
    nextCursor =
      sort !== undefined
        ? encodePageCursor({
            anchor: lastResult.id,
            score: null,
            sortKey: sort.sortKeyOf(lastResult.id).map(toComparableSortValue),
            sortSignature: sort.signature,
            binding,
          })
        : encodePageCursor({
            anchor: lastResult.id,
            score: lastResult.score ?? null,
            sortKey: null,
            sortSignature: null,
            binding,
          })
  }

  return { paginated: sliced, nextCursor }
}
