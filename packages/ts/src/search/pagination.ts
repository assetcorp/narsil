import { compareCodePoints, compareSortValues, type SortDirection, toComparableSortValue } from '../core/ordering'
import { decodePageCursor, encodePageCursor, type PageCursor, requireMatchingCursor } from './cursor'

export interface PaginationSortContext {
  signature: string
  directions: readonly SortDirection[]
  sortKeyOf(docId: string): readonly unknown[]
}

function ordersAfterAnchor<T extends { id: string; score: number }>(
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
  if (result.score < anchor.score) return true
  return result.score === anchor.score && compareCodePoints(result.id, anchor.anchor) > 0
}

export function applyPagination<T extends { id: string; score: number }>(
  results: T[],
  limit: number,
  offset: number,
  cursor?: string,
  sort?: PaginationSortContext,
): { paginated: T[]; nextCursor?: string } {
  if (limit <= 0) {
    return { paginated: [] }
  }

  let startIndex = 0

  if (cursor) {
    const decoded = decodePageCursor(cursor)
    requireMatchingCursor(decoded, cursor, sort?.signature ?? null, true)

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
          })
        : encodePageCursor({ anchor: lastResult.id, score: lastResult.score, sortKey: null, sortSignature: null })
  }

  return { paginated: sliced, nextCursor }
}
