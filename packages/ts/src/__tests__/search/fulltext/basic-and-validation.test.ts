import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import { ErrorCodes, NarsilError } from '../../../errors'
import { fulltextSearch } from '../../../search/fulltext'
import { english, populatePartition, schema } from './fixtures'

describe('fulltextSearch basic and validation', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    populatePartition(partition)
  })

  describe('empty and missing queries', () => {
    it('returns empty for undefined term', () => {
      const result = fulltextSearch(partition, {}, english, schema)
      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('returns empty for empty string term', () => {
      const result = fulltextSearch(partition, { term: '' }, english, schema)
      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('returns empty for whitespace-only term', () => {
      const result = fulltextSearch(partition, { term: '   ' }, english, schema)
      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('returns empty when query contains only stop words', () => {
      const result = fulltextSearch(partition, { term: 'the a an is' }, english, schema)
      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('returns empty for an empty fields array', () => {
      const result = fulltextSearch(partition, { term: 'fox', fields: [] }, english, schema)
      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })
  })

  describe('basic search', () => {
    it('finds documents matching a single term', () => {
      const result = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc3')
    })

    it('finds documents matching multiple terms', () => {
      const result = fulltextSearch(partition, { term: 'brown fox' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
    })

    it('returns results sorted by score in descending order', () => {
      const result = fulltextSearch(partition, { term: 'fox' }, english, schema)
      for (let i = 1; i < result.scored.length; i++) {
        expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
      }
    })

    it('returns correct totalMatched count', () => {
      const result = fulltextSearch(partition, { term: 'dog' }, english, schema)
      expect(result.totalMatched).toBe(result.scored.length)
    })

    it('includes score components in results', () => {
      const result = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(result.scored.length).toBeGreaterThan(0)
      const hit = result.scored[0]
      expect(hit.idf).toBeDefined()
      expect(hit.termFrequencies).toBeDefined()
      expect(hit.fieldLengths).toBeDefined()
      expect(hit.score).toBeGreaterThan(0)
    })
  })

  describe('field validation', () => {
    it('throws SEARCH_INVALID_FIELD for non-existent field', () => {
      expect(() => {
        fulltextSearch(partition, { term: 'fox', fields: ['nonexistent'] }, english, schema)
      }).toThrow(NarsilError)

      try {
        fulltextSearch(partition, { term: 'fox', fields: ['nonexistent'] }, english, schema)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_FIELD)
      }
    })

    it('throws SEARCH_INVALID_FIELD for non-text fields', () => {
      expect(() => {
        fulltextSearch(partition, { term: 'fox', fields: ['price'] }, english, schema)
      }).toThrow(NarsilError)
    })

    it('throws SEARCH_INVALID_FIELD for boolean fields', () => {
      expect(() => {
        fulltextSearch(partition, { term: 'true', fields: ['active'] }, english, schema)
      }).toThrow(NarsilError)
    })

    it('throws SEARCH_INVALID_FIELD for enum fields', () => {
      expect(() => {
        fulltextSearch(partition, { term: 'animals', fields: ['category'] }, english, schema)
      }).toThrow(NarsilError)
    })

    it('accepts valid string fields', () => {
      const result = fulltextSearch(partition, { term: 'fox', fields: ['title'] }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(0)
    })

    it('accepts string[] fields', () => {
      const p = createPartitionIndex(0)
      p.insert('tagged', { title: 'test', tags: ['fox', 'animal'] }, schema, english)
      const result = fulltextSearch(p, { term: 'fox', fields: ['tags'] }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(0)
    })
  })

  describe('field-scoped search', () => {
    it('restricts search to specified fields', () => {
      const result = fulltextSearch(partition, { term: 'fox', fields: ['title'] }, english, schema)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
    })

    it('returns empty when term only exists in non-specified field', () => {
      const result = fulltextSearch(partition, { term: 'jumped', fields: ['title'] }, english, schema)
      expect(result.totalMatched).toBe(0)
    })

    it('finds term in body when body is specified', () => {
      const result = fulltextSearch(partition, { term: 'jumped', fields: ['body'] }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })
  })
})
