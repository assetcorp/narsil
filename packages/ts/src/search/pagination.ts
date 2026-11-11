import { type SortDirection, toComparableSortValue } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { RESULT_WINDOW } from './constants'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from './cursor'
import type { CursorBinding } from './cursor-binding'
import { startAfterAnchor } from './cursor-page-code'

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
    if (!pinnedIds?.has(sliced[i].id)) return sliced[i]
  }
  return undefined
}

export interface PaginationSortContext {
  signature: string
  directions: readonly SortDirection[]
  sortKeyOf(docId: string): readonly unknown[]
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
  binding: CursorBinding,
  cursor?: string,
  sort?: PaginationSortContext,
  pinnedIds?: ReadonlySet<string>,
): { paginated: T[]; nextCursor?: string } {
  const decoded = cursor ? decodePageCursor(cursor) : null
  if (decoded !== null && cursor !== undefined) {
    requireMatchingCursor(decoded, cursor, sort?.signature ?? null, true, binding())
  }

  if (limit <= 0) {
    return { paginated: [] }
  }

  let startIndex = 0

  if (decoded !== null) {
    startIndex = startAfterAnchor(results, decoded, sort)
  }

  const afterOffset = startIndex + offset
  const sliced = results.slice(afterOffset, afterOffset + limit)

  let nextCursor: string | undefined

  const hasMore = afterOffset + limit < results.length
  const lastResult = lastOrganicResult(sliced, pinnedIds)
  const depth = afterOffset + sliced.length
  if (hasMore && lastResult !== undefined) {
    nextCursor = encodePageCursor({
      anchor: lastResult.id,
      score: sort === undefined ? (lastResult.score ?? null) : null,
      sortKey: sort === undefined ? null : sort.sortKeyOf(lastResult.id).map(toComparableSortValue),
      sortSignature: sort?.signature ?? null,
      depth,
      binding: binding(),
    })
  }

  return { paginated: sliced, nextCursor }
}
