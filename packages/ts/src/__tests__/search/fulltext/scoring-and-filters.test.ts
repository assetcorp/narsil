import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import { fulltextSearch } from '../../../search/fulltext'
import { english, populatePartition, schema } from './fixtures'

describe('fulltextSearch scoring, policies, and filters', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    populatePartition(partition)
  })

  describe('field boosting', () => {
    it('boosts scores for specified fields', () => {
      const p = createPartitionIndex(0)
      p.insert('d1', { title: 'search', body: 'other words' }, schema, english)
      p.insert('d2', { title: 'other words', body: 'search' }, schema, english)

      const result = fulltextSearch(p, { term: 'search', boost: { title: 10.0 } }, english, schema)

      expect(result.scored.length).toBe(2)
      expect(result.scored[0].docId).toBe('d1')
      expect(result.scored[0].score).toBeGreaterThan(result.scored[1].score)
    })

    it('without boost, scores depend on field length and term frequency', () => {
      const result = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(result.scored.length).toBeGreaterThan(0)
      for (const hit of result.scored) {
        expect(hit.score).toBeGreaterThan(0)
      }
    })
  })

  describe('termMatch policy', () => {
    it('defaults to any: returns docs matching at least one term', () => {
      const result = fulltextSearch(partition, { term: 'fox engines' }, english, schema)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc4')
    })

    it('all: returns only docs matching every query term', () => {
      const result = fulltextSearch(partition, { term: 'brown fox', termMatch: 'all' }, english, schema)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc3')
      expect(docIds).not.toContain('doc2')
      expect(docIds).not.toContain('doc4')
    })

    it('all: returns empty when no doc matches every term', () => {
      const result = fulltextSearch(partition, { term: 'fox engines retrieval', termMatch: 'all' }, english, schema)
      expect(result.totalMatched).toBe(0)
    })

    it('numeric: returns docs matching at least N terms', () => {
      const result = fulltextSearch(partition, { term: 'brown dog fox', termMatch: 2 }, english, schema)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc3')
    })

    it('numeric threshold of 1 behaves like any', () => {
      const resultAny = fulltextSearch(partition, { term: 'fox engines' }, english, schema)
      const resultOne = fulltextSearch(partition, { term: 'fox engines', termMatch: 1 }, english, schema)
      expect(resultAny.totalMatched).toBe(resultOne.totalMatched)
    })

    it('impossible threshold returns empty', () => {
      const result = fulltextSearch(partition, { term: 'fox dog', termMatch: 10 }, english, schema)
      expect(result.totalMatched).toBe(0)
    })

    it('deduplicates query tokens before counting', () => {
      const result = fulltextSearch(partition, { term: 'fox fox fox', termMatch: 'all' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })
  })

  describe('minScore filtering', () => {
    it('filters out documents below minScore', () => {
      const unfiltered = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(unfiltered.totalMatched).toBeGreaterThan(0)

      const maxScore = Math.max(...unfiltered.scored.map(s => s.score))
      const highThreshold = maxScore + 1

      const filtered = fulltextSearch(partition, { term: 'fox', minScore: highThreshold }, english, schema)
      expect(filtered.totalMatched).toBe(0)
    })

    it('keeps documents at or above minScore', () => {
      const unfiltered = fulltextSearch(partition, { term: 'fox' }, english, schema)
      const minAvailableScore = Math.min(...unfiltered.scored.map(s => s.score))

      const filtered = fulltextSearch(partition, { term: 'fox', minScore: minAvailableScore }, english, schema)
      expect(filtered.totalMatched).toBe(unfiltered.totalMatched)
    })

    it('no filtering when minScore is undefined', () => {
      const result = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(result.totalMatched).toBeGreaterThan(0)
    })

    it('no filtering when minScore is 0', () => {
      const withZero = fulltextSearch(partition, { term: 'fox', minScore: 0 }, english, schema)
      const without = fulltextSearch(partition, { term: 'fox' }, english, schema)
      expect(withZero.totalMatched).toBe(without.totalMatched)
    })
  })

  describe('filter integration', () => {
    it('intersects text search results with filter results', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'fox',
          filters: { fields: { active: { eq: true } } },
        },
        english,
        schema,
      )
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).not.toContain('doc3')
    })

    it('returns empty when filter excludes all text matches', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'fox',
          filters: { fields: { category: { eq: 'technology' } } },
        },
        english,
        schema,
      )
      expect(result.totalMatched).toBe(0)
    })

    it('combines text search with numeric range filters', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'dog',
          filters: { fields: { price: { lte: 25 } } },
        },
        english,
        schema,
      )
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc2')
      expect(docIds).not.toContain('doc3')
    })

    it('applies filters even with termMatch', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'brown fox',
          termMatch: 'all',
          filters: { fields: { price: { gte: 25 } } },
        },
        english,
        schema,
      )
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc3')
      expect(docIds).not.toContain('doc1')
    })
  })
})
