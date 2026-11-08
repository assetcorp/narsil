import { pageStart } from '#platform/page-start'
import { compareCodePoints } from '../core/ordering'
import { compareSortValues } from '../core/ordering/sort-comparison'
import { ErrorCodes, NarsilError } from '../errors'
import type { PageCursor } from './cursor'
import type { PaginationSortContext } from './pagination'

export function startAfterAnchor<T extends { id: string; score?: number }>(
  results: T[],
  anchor: PageCursor,
  sort: PaginationSortContext | undefined,
): number {
  const words = Math.max(1, Math.ceil(results.length / 32))
  const afterAnchor = new Uint32Array(words)
  const sorted = sort !== undefined && anchor.sortKey !== null
  const scores = sorted ? null : new Float64Array(results.length)
  let scorePresent: Uint32Array | null = null
  for (let position = 0; position < results.length; position++) {
    const result = results[position]
    const comparison =
      (sort !== undefined && anchor.sortKey !== null
        ? compareSortValues(sort.sortKeyOf(result.id), anchor.sortKey, sort.directions)
        : 0) || compareCodePoints(result.id, anchor.anchor)
    if (comparison > 0) afterAnchor[position >>> 5] |= 1 << (position & 31)
    if (scores !== null) {
      if (result.score === undefined) {
        scorePresent ??= new Uint32Array(words).fill(0xffffffff)
        scorePresent[position >>> 5] &= ~(1 << (position & 31))
      } else {
        scores[position] = result.score
      }
    }
  }
  const start = pageStart(results.length, sorted, scores, scorePresent, afterAnchor, anchor.score)
  if (start < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The result page cannot be selected', { status: start })
  }
  return start
}
