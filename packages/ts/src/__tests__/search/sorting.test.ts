import { describe, expect, it } from 'vitest'
import { toComparableSortValue } from '../../core/ordering'
import { applySorting, readFieldValue } from '../../search/sorting'
import type { Hit } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { SortSpec } from '../../types/search'

function makeHit(id: string, score: number): Hit {
  return { id, score, document: {} }
}

function sortWith(hits: Hit[], sort: SortSpec, docs: Record<string, AnyDocument>): Hit[] {
  const fields = Object.keys(sort)
  return applySorting(hits, sort, docId =>
    fields.map(field => toComparableSortValue(readFieldValue(docs[docId] ?? {}, field))),
  )
}

describe('applySorting', () => {
  describe('sort by number', () => {
    it('sorts ascending by a numeric field', () => {
      const docs: Record<string, AnyDocument> = {
        a: { price: 30 },
        b: { price: 10 },
        c: { price: 20 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { price: 'asc' }, docs)
      expect(result.map(h => h.id)).toEqual(['b', 'c', 'a'])
    })

    it('sorts descending by a numeric field', () => {
      const docs: Record<string, AnyDocument> = {
        a: { price: 30 },
        b: { price: 10 },
        c: { price: 20 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { price: 'desc' }, docs)
      expect(result.map(h => h.id)).toEqual(['a', 'c', 'b'])
    })
  })

  describe('sort by string', () => {
    it('sorts strings with locale awareness', () => {
      const docs: Record<string, AnyDocument> = {
        a: { name: 'banana' },
        b: { name: 'Apple' },
        c: { name: 'cherry' },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { name: 'asc' }, docs)
      expect(result.map(h => h.id)).toEqual(['b', 'a', 'c'])
    })

    it('sorts strings descending', () => {
      const docs: Record<string, AnyDocument> = {
        a: { name: 'banana' },
        b: { name: 'apple' },
        c: { name: 'cherry' },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { name: 'desc' }, docs)
      expect(result.map(h => h.id)).toEqual(['c', 'a', 'b'])
    })
  })

  describe('sort by boolean', () => {
    it('sorts booleans where false comes before true in ascending order', () => {
      const docs: Record<string, AnyDocument> = {
        a: { active: true },
        b: { active: false },
        c: { active: true },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { active: 'asc' }, docs)
      expect(result[0].id).toBe('b')
    })

    it('sorts booleans descending with true first', () => {
      const docs: Record<string, AnyDocument> = {
        a: { active: false },
        b: { active: true },
        c: { active: false },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { active: 'desc' }, docs)
      expect(result[0].id).toBe('b')
    })
  })

  describe('multi-field sort', () => {
    it('uses a tiebreaker field when primary values are equal', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit', price: 30 },
        b: { category: 'fruit', price: 10 },
        c: { category: 'vegetable', price: 20 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { category: 'asc', price: 'asc' }, docs)
      expect(result.map(h => h.id)).toEqual(['b', 'a', 'c'])
    })
  })

  describe('missing fields', () => {
    it('pushes documents with missing sort fields to the end', () => {
      const docs: Record<string, AnyDocument> = {
        a: { price: 10 },
        b: {},
        c: { price: 5 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { price: 'asc' }, docs)
      expect(result[0].id).toBe('c')
      expect(result[1].id).toBe('a')
      expect(result[2].id).toBe('b')
    })

    it('pushes documents with missing fields to end in descending order too', () => {
      const docs: Record<string, AnyDocument> = {
        a: { price: 10 },
        b: {},
        c: { price: 5 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { price: 'desc' }, docs)
      expect(result[0].id).toBe('a')
      expect(result[1].id).toBe('c')
      expect(result[2].id).toBe('b')
    })
  })

  describe('NaN handling', () => {
    it('pushes NaN values to the end', () => {
      const docs: Record<string, AnyDocument> = {
        a: { score: NaN },
        b: { score: 5 },
        c: { score: 10 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { score: 'asc' }, docs)
      expect(result[0].id).toBe('b')
      expect(result[1].id).toBe('c')
      expect(result[2].id).toBe('a')
    })

    it('pushes NaN values to the end in descending order too', () => {
      const docs: Record<string, AnyDocument> = {
        a: { score: NaN },
        b: { score: 5 },
        c: { score: 10 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { score: 'desc' }, docs)
      expect(result[0].id).toBe('c')
      expect(result[1].id).toBe('b')
      expect(result[2].id).toBe('a')
    })
  })

  describe('empty inputs', () => {
    it('returns empty array when hits array is empty', () => {
      const result = sortWith([], { price: 'asc' }, {})
      expect(result).toEqual([])
    })

    it('returns hits unchanged when sort config is empty', () => {
      const hits = [makeHit('a', 3), makeHit('b', 1)]
      const result = sortWith(hits, {}, {})
      expect(result.map(h => h.id)).toEqual(['a', 'b'])
    })
  })

  describe('nested field paths', () => {
    it('resolves dot-notation paths for nested documents', () => {
      const docs: Record<string, AnyDocument> = {
        a: { metadata: { rating: 3 } },
        b: { metadata: { rating: 1 } },
        c: { metadata: { rating: 2 } },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2), makeHit('c', 3)]
      const result = sortWith(hits, { 'metadata.rating': 'asc' }, docs)
      expect(result.map(h => h.id)).toEqual(['b', 'c', 'a'])
    })
  })

  describe('stability', () => {
    it('does not mutate the original hits array', () => {
      const docs: Record<string, AnyDocument> = {
        a: { price: 30 },
        b: { price: 10 },
      }
      const hits = [makeHit('a', 1), makeHit('b', 2)]
      const originalOrder = hits.map(h => h.id)
      sortWith(hits, { price: 'asc' }, docs)
      expect(hits.map(h => h.id)).toEqual(originalOrder)
    })
  })
})
