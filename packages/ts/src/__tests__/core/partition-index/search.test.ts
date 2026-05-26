import { beforeEach, describe, expect, it } from 'vitest'
import type { PartitionIndex } from '../../../core/partition'
import { english, makePartition, simpleSchema } from './fixtures'

describe('PartitionIndex search, filters, and facets', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = makePartition()
  })

  describe('searchFulltext', () => {
    it('returns matching documents scored by BM25', () => {
      partition.insert('doc1', { title: 'search engine' }, simpleSchema, english)
      partition.insert('doc2', { title: 'game engine' }, simpleSchema, english)
      partition.insert('doc3', { title: 'search results' }, simpleSchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'search', position: 0 }],
      })

      expect(result.totalMatched).toBe(2)
      expect(result.scored.map(s => s.docId).sort()).toEqual(['doc1', 'doc3'])
    })

    it('applies field filtering', () => {
      partition.insert('doc1', { title: 'hello world', body: 'search content' }, simpleSchema, english)

      const titleOnly = partition.searchFulltext({
        queryTokens: [{ token: 'search', position: 0 }],
        fields: ['title'],
      })
      expect(titleOnly.totalMatched).toBe(0)

      const bodyOnly = partition.searchFulltext({
        queryTokens: [{ token: 'search', position: 0 }],
        fields: ['body'],
      })
      expect(bodyOnly.totalMatched).toBe(1)
    })

    it('applies field boosting', () => {
      partition.insert('doc1', { title: 'search', body: 'other' }, simpleSchema, english)
      partition.insert('doc2', { body: 'search' }, simpleSchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'search', position: 0 }],
        boost: { title: 5.0 },
      })

      expect(result.scored[0].docId).toBe('doc1')
      expect(result.scored[0].score).toBeGreaterThan(result.scored[1].score)
    })

    it('supports fuzzy matching with tolerance', () => {
      partition.insert('doc1', { title: 'search databases' }, simpleSchema, english)

      const exact = partition.searchFulltext({
        queryTokens: [{ token: 'serch', position: 0 }],
        exact: true,
      })
      expect(exact.totalMatched).toBe(0)

      const fuzzy = partition.searchFulltext({
        queryTokens: [{ token: 'serch', position: 0 }],
        tolerance: 2,
        prefixLength: 1,
      })
      expect(fuzzy.totalMatched).toBe(1)
    })

    it('returns empty results for empty query tokens', () => {
      partition.insert('doc1', { title: 'hello' }, simpleSchema, english)
      const result = partition.searchFulltext({ queryTokens: [] })
      expect(result.totalMatched).toBe(0)
    })

    it('returns score components', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      const result = partition.searchFulltext({
        queryTokens: [{ token: 'hello', position: 0 }],
      })
      expect(result.scored[0].idf).toBeDefined()
      expect(result.scored[0].termFrequencies).toBeDefined()
      expect(result.scored[0].fieldLengths).toBeDefined()
    })

    it('scores results in descending order', () => {
      partition.insert('doc1', { title: 'hello hello hello' }, simpleSchema, english)
      partition.insert('doc2', { title: 'hello world search test' }, simpleSchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'hello', position: 0 }],
      })

      for (let i = 1; i < result.scored.length; i++) {
        expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
      }
    })
  })

  describe('applyFilters', () => {
    it('filters by numeric field', () => {
      partition.insert('doc1', { title: 'one', price: 10 }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', price: 20 }, simpleSchema, english)
      partition.insert('doc3', { title: 'three', price: 30 }, simpleSchema, english)

      const result = partition.applyFilters({ fields: { price: { gte: 20 } } }, simpleSchema)
      expect(result.size).toBe(2)
      expect(result.has('doc2')).toBe(true)
      expect(result.has('doc3')).toBe(true)
    })

    it('filters by boolean field', () => {
      partition.insert('doc1', { title: 'one', active: true }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', active: false }, simpleSchema, english)

      const result = partition.applyFilters({ fields: { active: { eq: true } } }, simpleSchema)
      expect(result.size).toBe(1)
      expect(result.has('doc1')).toBe(true)
    })

    it('filters by enum field', () => {
      partition.insert('doc1', { title: 'one', category: 'books' }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', category: 'electronics' }, simpleSchema, english)

      const result = partition.applyFilters({ fields: { category: { eq: 'electronics' } } }, simpleSchema)
      expect(result.size).toBe(1)
      expect(result.has('doc2')).toBe(true)
    })

    it('supports AND combinators', () => {
      partition.insert('doc1', { title: 'one', price: 10, active: true }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', price: 20, active: true }, simpleSchema, english)
      partition.insert('doc3', { title: 'three', price: 30, active: false }, simpleSchema, english)

      const result = partition.applyFilters(
        {
          and: [{ fields: { price: { gte: 20 } } }, { fields: { active: { eq: true } } }],
        },
        simpleSchema,
      )
      expect(result.size).toBe(1)
      expect(result.has('doc2')).toBe(true)
    })
  })

  describe('computeFacets', () => {
    it('computes facet counts for enum fields', () => {
      partition.insert('doc1', { title: 'one', category: 'books' }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', category: 'books' }, simpleSchema, english)
      partition.insert('doc3', { title: 'three', category: 'electronics' }, simpleSchema, english)

      const allIds = new Set(['doc1', 'doc2', 'doc3'])
      const facets = partition.computeFacets(allIds, { category: {} }, simpleSchema)

      expect(facets.category.values.books).toBe(2)
      expect(facets.category.values.electronics).toBe(1)
    })

    it('computes facet ranges for numeric fields', () => {
      partition.insert('doc1', { title: 'one', price: 5 }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', price: 15 }, simpleSchema, english)
      partition.insert('doc3', { title: 'three', price: 25 }, simpleSchema, english)

      const allIds = new Set(['doc1', 'doc2', 'doc3'])
      const facets = partition.computeFacets(
        allIds,
        {
          price: {
            ranges: [
              { from: 0, to: 10 },
              { from: 10, to: 20 },
              { from: 20, to: 30 },
            ],
          },
        },
        simpleSchema,
      )

      expect(facets.price.values['0-10']).toBe(1)
      expect(facets.price.values['10-20']).toBe(1)
      expect(facets.price.values['20-30']).toBe(1)
    })

    it('respects facet limit', () => {
      partition.insert('doc1', { title: 'a', category: 'books' }, simpleSchema, english)
      partition.insert('doc2', { title: 'b', category: 'electronics' }, simpleSchema, english)
      partition.insert('doc3', { title: 'c', category: 'clothing' }, simpleSchema, english)

      const allIds = new Set(['doc1', 'doc2', 'doc3'])
      const facets = partition.computeFacets(
        allIds,
        {
          category: { limit: 2 },
        },
        simpleSchema,
      )

      expect(Object.keys(facets.category.values).length).toBe(2)
    })
  })
})
