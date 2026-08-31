import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { encodePageCursor } from '../../search/cursor'
import { applyPagination, type PaginationSortContext } from '../../search/pagination'

const binding = 'aaaaaaaa'

function makeResults(count: number): Array<{ id: string; score: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc${i + 1}`,
    score: count - i,
  }))
}

describe('pagination', () => {
  describe('applyPagination', () => {
    it('returns first page with limit and zero offset', () => {
      const results = makeResults(10)
      const { paginated, nextCursor } = applyPagination(results, 3, 0, binding)
      expect(paginated).toHaveLength(3)
      expect(paginated[0].id).toBe('doc1')
      expect(paginated[1].id).toBe('doc2')
      expect(paginated[2].id).toBe('doc3')
      expect(nextCursor).toBeDefined()
    })

    it('applies offset correctly', () => {
      const results = makeResults(10)
      const { paginated } = applyPagination(results, 3, 2, binding)
      expect(paginated).toHaveLength(3)
      expect(paginated[0].id).toBe('doc3')
      expect(paginated[1].id).toBe('doc4')
      expect(paginated[2].id).toBe('doc5')
    })

    it('returns empty when limit is 0', () => {
      const results = makeResults(5)
      const { paginated, nextCursor } = applyPagination(results, 0, 0, binding)
      expect(paginated).toHaveLength(0)
      expect(nextCursor).toBeUndefined()
    })

    it('returns all results when limit exceeds result count', () => {
      const results = makeResults(3)
      const { paginated, nextCursor } = applyPagination(results, 100, 0, binding)
      expect(paginated).toHaveLength(3)
      expect(nextCursor).toBeUndefined()
    })

    it('returns empty when offset exceeds result count', () => {
      const results = makeResults(3)
      const { paginated, nextCursor } = applyPagination(results, 10, 100, binding)
      expect(paginated).toHaveLength(0)
      expect(nextCursor).toBeUndefined()
    })

    it('does not return nextCursor on the last page', () => {
      const results = makeResults(6)
      const { paginated, nextCursor } = applyPagination(results, 3, 3, binding)
      expect(paginated).toHaveLength(3)
      expect(nextCursor).toBeUndefined()
    })

    it('uses cursor to resume from the correct position', () => {
      const results = makeResults(10)
      const firstPage = applyPagination(results, 3, 0, binding)
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = applyPagination(results, 3, 0, binding, firstPage.nextCursor)
      expect(secondPage.paginated).toHaveLength(3)
      expect(secondPage.paginated[0].id).toBe('doc4')
      expect(secondPage.paginated[1].id).toBe('doc5')
      expect(secondPage.paginated[2].id).toBe('doc6')
    })

    it('cursor after last result returns empty', () => {
      const results = makeResults(3)
      const firstPage = applyPagination(results, 3, 0, binding)
      expect(firstPage.nextCursor).toBeUndefined()

      const lastItem = results[results.length - 1]
      const fakeCursor = encodePageCursor({
        anchor: lastItem.id,
        score: lastItem.score,
        sortKey: null,
        sortSignature: null,
        binding,
      })
      const nextPage = applyPagination(results, 3, 0, binding, fakeCursor)
      expect(nextPage.paginated).toHaveLength(0)
    })

    it('cursor with offset skips additional results', () => {
      const results = makeResults(10)
      const firstPage = applyPagination(results, 2, 0, binding)

      const secondPage = applyPagination(results, 2, 1, binding, firstPage.nextCursor)
      expect(secondPage.paginated[0].id).toBe('doc4')
    })

    it('resumes past tied scores by document id', () => {
      const results = [
        { id: 'a', score: 5 },
        { id: 'b', score: 5 },
        { id: 'c', score: 5 },
        { id: 'd', score: 3 },
        { id: 'e', score: 1 },
      ]
      const firstPage = applyPagination(results, 2, 0, binding)
      expect(firstPage.paginated.map(r => r.id)).toEqual(['a', 'b'])
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = applyPagination(results, 2, 0, binding, firstPage.nextCursor)
      expect(secondPage.paginated.map(r => r.id)).toEqual(['c', 'd'])
    })

    it('rejects a cursor whose binding names a different query', () => {
      const results = makeResults(10)
      const firstPage = applyPagination(results, 3, 0, binding)
      expect(firstPage.nextCursor).toBeDefined()

      expect(() => applyPagination(results, 3, 0, 'bbbbbbbb', firstPage.nextCursor)).toThrow(NarsilError)
      try {
        applyPagination(results, 3, 0, 'bbbbbbbb', firstPage.nextCursor)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
        expect((e as NarsilError).message).toContain('different query')
      }
    })

    it('rejects a sorted cursor on an unsorted search', () => {
      const results = makeResults(3)
      const sortedCursor = encodePageCursor({
        anchor: 'doc1',
        score: null,
        sortKey: ['Widget'],
        sortSignature: '[["title","asc"]]',
        binding,
      })
      expect(() => applyPagination(results, 3, 0, binding, sortedCursor)).toThrow(NarsilError)
      try {
        applyPagination(results, 3, 0, binding, sortedCursor)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
      }
    })
  })

  describe('sorted pagination', () => {
    const titles: Record<string, string> = {
      doc1: 'Apple',
      doc2: 'apple',
      doc3: 'Banana',
      doc4: 'Zebra',
      doc5: 'école',
    }
    const sortedResults = ['doc1', 'doc2', 'doc3', 'doc4', 'doc5'].map(id => ({ id, score: 0 }))
    const sortContext: PaginationSortContext = {
      signature: '[["title","asc"]]',
      directions: ['asc'],
      sortKeyOf: docId => [titles[docId]],
    }

    it('anchors on sort values and pages in sort value order', () => {
      const firstPage = applyPagination(sortedResults, 2, 0, binding, undefined, sortContext)
      expect(firstPage.paginated.map(r => r.id)).toEqual(['doc1', 'doc2'])
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = applyPagination(sortedResults, 2, 0, binding, firstPage.nextCursor, sortContext)
      expect(secondPage.paginated.map(r => r.id)).toEqual(['doc3', 'doc4'])

      const thirdPage = applyPagination(sortedResults, 2, 0, binding, secondPage.nextCursor, sortContext)
      expect(thirdPage.paginated.map(r => r.id)).toEqual(['doc5'])
      expect(thirdPage.nextCursor).toBeUndefined()
    })

    it('rejects a cursor made under a different sort', () => {
      const otherSort = encodePageCursor({
        anchor: 'doc2',
        score: null,
        sortKey: [10],
        sortSignature: '[["price","desc"]]',
        binding,
      })
      expect(() => applyPagination(sortedResults, 2, 0, binding, otherSort, sortContext)).toThrow(NarsilError)
    })

    it('rejects a score cursor on a sorted search', () => {
      const scoreCursor = encodePageCursor({
        anchor: 'doc2',
        score: 4.5,
        sortKey: null,
        sortSignature: null,
        binding,
      })
      expect(() => applyPagination(sortedResults, 2, 0, binding, scoreCursor, sortContext)).toThrow(NarsilError)
    })
  })

  describe('edge cases', () => {
    it('handles empty results array', () => {
      const { paginated, nextCursor } = applyPagination([], 10, 0, binding)
      expect(paginated).toEqual([])
      expect(nextCursor).toBeUndefined()
    })

    it('handles negative limit by treating as 0', () => {
      const results = makeResults(5)
      const { paginated } = applyPagination(results, -1, 0, binding)
      expect(paginated).toEqual([])
    })

    it('handles cursor pointing past all results', () => {
      const results = makeResults(3)
      const cursor = encodePageCursor({ anchor: 'zzz', score: -999, sortKey: null, sortSignature: null, binding })
      const { paginated } = applyPagination(results, 10, 0, binding, cursor)
      expect(paginated).toEqual([])
    })
  })
})
