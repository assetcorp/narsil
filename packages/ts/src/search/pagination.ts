import { compareCodePoints, compareSortValues, type SortDirection, toComparableSortValue } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { decodePageCursor, encodePageCursor, type PageCursor, requireMatchingCursor } from './cursor'

export const RESULT_WINDOW = 10_000
export const DEFAULT_PAGE_SIZE = 10

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

export function applyPagination<T extends { id: string; score?: number }>(
  results: T[],
  limit: number,
  offset: number,
  binding: string,
  cursor?: string,
  sort?: PaginationSortContext,
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
  if (hasMore && sliced.length > 0) {
    const lastResult = sliced[sliced.length - 1]
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
