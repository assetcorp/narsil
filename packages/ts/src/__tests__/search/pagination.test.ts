import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { applyPagination, decodeCursor, encodeCursor, type SearchCursor } from '../../search/pagination'

function makeResults(count: number): Array<{ id: string; score: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc${i + 1}`,
    score: count - i,
  }))
}

describe('pagination', () => {
  describe('encodeCursor and decodeCursor', () => {
    it('round-trips a single cursor entry', () => {
      const state: SearchCursor[] = [{ s: 5.5, d: 'doc42', p: 0 }]
      const encoded = encodeCursor(state)
      const decoded = decodeCursor(encoded)
      expect(decoded).toEqual(state)
    })

    it('round-trips multiple cursor entries for multi-partition state', () => {
      const state: SearchCursor[] = [
        { s: 10.2, d: 'doc1', p: 0 },
        { s: 8.7, d: 'doc5', p: 1 },
        { s: 3.1, d: 'doc9', p: 2 },
      ]
      const encoded = encodeCursor(state)
      const decoded = decodeCursor(encoded)
      expect(decoded).toEqual(state)
    })

    it('round-trips an empty array', () => {
      const state: SearchCursor[] = []
      const encoded = encodeCursor(state)
      const decoded = decodeCursor(encoded)
      expect(decoded).toEqual([])
    })

    it('round-trips cursor entries with zero score', () => {
      const state: SearchCursor[] = [{ s: 0, d: 'doc0', p: 0 }]
      const encoded = encodeCursor(state)
      const decoded = decodeCursor(encoded)
      expect(decoded).toEqual(state)
    })
  })

  describe('decodeCursor validation', () => {
    it('throws SEARCH_INVALID_CURSOR for invalid base64', () => {
      expect(() => decodeCursor('!!!not-base64!!!')).toThrow(NarsilError)
      try {
        decodeCursor('!!!not-base64!!!')
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
      }
    })

    it('throws SEARCH_INVALID_CURSOR for truncated JSON', () => {
      const truncated =
        typeof Buffer !== 'undefined' ? Buffer.from('{"s":1,"d"').toString('base64') : btoa('{"s":1,"d"')
      expect(() => decodeCursor(truncated)).toThrow(NarsilError)
      try {
        decodeCursor(truncated)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
      }
    })

    it('throws SEARCH_INVALID_CURSOR when decoded value is not an array', () => {
      const notArray =
        typeof Buffer !== 'undefined'
          ? Buffer.from('{"s":1,"d":"x","p":0}').toString('base64')
          : btoa('{"s":1,"d":"x","p":0}')
      expect(() => decodeCursor(notArray)).toThrow(NarsilError)
      try {
        decodeCursor(notArray)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
      }
    })

    it('throws SEARCH_INVALID_CURSOR when entry has non-finite score', () => {
      const encoded =
        typeof Buffer !== 'undefined'
          ? Buffer.from(JSON.stringify([{ s: null, d: 'doc1', p: 0 }])).toString('base64')
          : btoa(JSON.stringify([{ s: null, d: 'doc1', p: 0 }]))
      expect(() => decodeCursor(encoded)).toThrow(NarsilError)
    })

    it('throws SEARCH_INVALID_CURSOR when entry has non-string docId', () => {
      const encoded =
        typeof Buffer !== 'undefined'
          ? Buffer.from(JSON.stringify([{ s: 1.0, d: 123, p: 0 }])).toString('base64')
          : btoa(JSON.stringify([{ s: 1.0, d: 123, p: 0 }]))
      expect(() => decodeCursor(encoded)).toThrow(NarsilError)
    })

    it('throws SEARCH_INVALID_CURSOR when entry has negative partition index', () => {
      const encoded =
        typeof Buffer !== 'undefined'
          ? Buffer.from(JSON.stringify([{ s: 1.0, d: 'doc1', p: -1 }])).toString('base64')
          : btoa(JSON.stringify([{ s: 1.0, d: 'doc1', p: -1 }]))
      expect(() => decodeCursor(encoded)).toThrow(NarsilError)
    })

    it('throws SEARCH_INVALID_CURSOR when entry has fractional partition index', () => {
      const encoded =
        typeof Buffer !== 'undefined'
          ? Buffer.from(JSON.stringify([{ s: 1.0, d: 'doc1', p: 0.5 }])).toString('base64')
          : btoa(JSON.stringify([{ s: 1.0, d: 'doc1', p: 0.5 }]))
      expect(() => decodeCursor(encoded)).toThrow(NarsilError)
    })
  })

  describe('applyPagination', () => {
    it('returns first page with limit and zero offset', () => {
      const results = makeResults(10)
      const { paginated, nextCursor } = applyPagination(results, 3, 0)
      expect(paginated).toHaveLength(3)
      expect(paginated[0].id).toBe('doc1')
      expect(paginated[1].id).toBe('doc2')
      expect(paginated[2].id).toBe('doc3')
      expect(nextCursor).toBeDefined()
    })

    it('applies offset correctly', () => {
      const results = makeResults(10)
      const { paginated } = applyPagination(results, 3, 2)
      expect(paginated).toHaveLength(3)
      expect(paginated[0].id).toBe('doc3')
      expect(paginated[1].id).toBe('doc4')
      expect(paginated[2].id).toBe('doc5')
    })

    it('returns empty when limit is 0', () => {
      const results = makeResults(5)
      const { paginated, nextCursor } = applyPagination(results, 0, 0)
      expect(paginated).toHaveLength(0)
      expect(nextCursor).toBeUndefined()
    })

    it('returns all results when limit exceeds result count', () => {
      const results = makeResults(3)
      const { paginated, nextCursor } = applyPagination(results, 100, 0)
      expect(paginated).toHaveLength(3)
      expect(nextCursor).toBeUndefined()
    })

    it('returns empty when offset exceeds result count', () => {
      const results = makeResults(3)
      const { paginated, nextCursor } = applyPagination(results, 10, 100)
      expect(paginated).toHaveLength(0)
      expect(nextCursor).toBeUndefined()
    })

    it('does not return nextCursor on the last page', () => {
      const results = makeResults(6)
      const { paginated, nextCursor } = applyPagination(results, 3, 3)
      expect(paginated).toHaveLength(3)
      expect(nextCursor).toBeUndefined()
    })

    it('uses cursor to resume from the correct position', () => {
      const results = makeResults(10)
      const firstPage = applyPagination(results, 3, 0)
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = applyPagination(results, 3, 0, firstPage.nextCursor)
      expect(secondPage.paginated).toHaveLength(3)
      expect(secondPage.paginated[0].id).toBe('doc4')
      expect(secondPage.paginated[1].id).toBe('doc5')
      expect(secondPage.paginated[2].id).toBe('doc6')
    })

    it('cursor after last result returns empty', () => {
      const results = makeResults(3)
      const firstPage = applyPagination(results, 3, 0)
      expect(firstPage.nextCursor).toBeUndefined()

      const lastItem = results[results.length - 1]
      const fakeCursor = encodeCursor([{ s: lastItem.score, d: lastItem.id, p: 0 }])
      const nextPage = applyPagination(results, 3, 0, fakeCursor)
      expect(nextPage.paginated).toHaveLength(0)
    })

    it('cursor with offset skips additional results', () => {
      const results = makeResults(10)
      const firstPage = applyPagination(results, 2, 0)

      const secondPage = applyPagination(results, 2, 1, firstPage.nextCursor)
      expect(secondPage.paginated[0].id).toBe('doc4')
    })

    it('handles results with tied scores', () => {
      const results = [
        { id: 'a', score: 5 },
        { id: 'b', score: 5 },
        { id: 'c', score: 5 },
        { id: 'd', score: 3 },
        { id: 'e', score: 1 },
      ]
      const firstPage = applyPagination(results, 2, 0)
      expect(firstPage.paginated).toHaveLength(2)
      expect(firstPage.nextCursor).toBeDefined()
    })
  })
})
