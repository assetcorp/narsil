import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { ErrorCodes, NarsilError } from '../../errors'
import { fulltextSearch } from '../../search/fulltext'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to', 'it']),
}

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
  active: 'boolean',
  category: 'enum',
  tags: 'string[]',
}

function populatePartition(partition: PartitionIndex): void {
  partition.insert(
    'doc1',
    {
      title: 'quick brown fox',
      body: 'the fox jumped over the fence',
      price: 10,
      active: true,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc2',
    {
      title: 'lazy dog sleeps',
      body: 'the dog rested under the tree',
      price: 20,
      active: true,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc3',
    {
      title: 'brown dog runs',
      body: 'the brown dog chased the fox',
      price: 30,
      active: false,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc4',
    {
      title: 'search engines work',
      body: 'indexing documents for fast retrieval',
      price: 50,
      active: true,
      category: 'technology',
    },
    schema,
    english,
  )
}

describe('fulltextSearch', () => {
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

  describe('fuzzy matching', () => {
    it('exact mode does not match near-misses', () => {
      const result = fulltextSearch(partition, { term: 'fex', exact: true }, english, schema)
      expect(result.totalMatched).toBe(0)
    })

    it('finds near-matches with tolerance', () => {
      const result = fulltextSearch(partition, { term: 'fex', tolerance: 1, prefixLength: 1 }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })

    it('does not find matches when tolerance is too low', () => {
      const result = fulltextSearch(partition, { term: 'abcdef', tolerance: 1 }, english, schema)
      expect(result.totalMatched).toBe(0)
    })

    it('termMatch works with fuzzy matching', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'brwn fex',
          tolerance: 1,
          prefixLength: 1,
          termMatch: 'all',
        },
        english,
        schema,
      )
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc3')
    })

    it('respects prefixLength for fuzzy matching', () => {
      const result = fulltextSearch(partition, { term: 'xox', tolerance: 1, prefixLength: 1 }, english, schema)
      expect(result.totalMatched).toBe(0)
    })
  })

  describe('BM25 customization', () => {
    it('uses custom BM25 params when provided', () => {
      const defaultResult = fulltextSearch(partition, { term: 'fox' }, english, schema)

      const customResult = fulltextSearch(partition, { term: 'fox' }, english, schema, {
        bm25Params: { k1: 2.0, b: 0.5 },
      })

      expect(defaultResult.totalMatched).toBe(customResult.totalMatched)
      expect(defaultResult.scored[0].score).not.toBe(customResult.scored[0].score)
    })
  })

  describe('global statistics (DFS mode)', () => {
    it('uses global statistics for scoring when provided', () => {
      const localResult = fulltextSearch(partition, { term: 'fox' }, english, schema)

      const globalStats: import('../../types/internal').GlobalStatistics = {
        totalDocuments: 1000,
        docFrequencies: { fox: 500 },
        totalFieldLengths: { title: 5000, body: 10000 },
        averageFieldLengths: { title: 5, body: 10 },
      }

      const globalResult = fulltextSearch(partition, { term: 'fox' }, english, schema, { globalStats })

      expect(globalResult.totalMatched).toBe(localResult.totalMatched)
      expect(globalResult.scored[0].score).not.toBe(localResult.scored[0].score)
    })
  })

  describe('stop word handling', () => {
    it('removes stop words from query before searching', () => {
      const result = fulltextSearch(partition, { term: 'the fox' }, english, schema)
      expect(result.totalMatched).toBeGreaterThan(0)
    })

    it('respects custom stop word override', () => {
      const noStopWords = fulltextSearch(partition, { term: 'fox' }, english, schema, { stopWords: new Set() })
      expect(noStopWords.totalMatched).toBeGreaterThan(0)
    })

    it('respects stop word override function', () => {
      const result = fulltextSearch(partition, { term: 'the fox' }, english, schema, {
        stopWords: defaults => {
          const copy = new Set(defaults)
          copy.delete('the')
          return copy
        },
      })
      expect(result.totalMatched).toBeGreaterThanOrEqual(0)
    })
  })

  describe('nested schema', () => {
    const nestedSchema: SchemaDefinition = {
      metadata: {
        author: 'string',
        rating: 'number',
      },
      title: 'string',
    }

    it('validates nested field paths', () => {
      const p = createPartitionIndex(0)
      p.insert('nested1', { title: 'book', metadata: { author: 'tolkien', rating: 5 } }, nestedSchema, english)

      const result = fulltextSearch(p, { term: 'tolkien', fields: ['metadata.author'] }, english, nestedSchema)
      expect(result.totalMatched).toBe(1)
    })

    it('rejects nested non-text fields', () => {
      expect(() => {
        fulltextSearch(partition, { term: 'test', fields: ['metadata.rating'] }, english, nestedSchema)
      }).toThrow(NarsilError)
    })
  })

  describe('custom tokenizer', () => {
    it('uses custom tokenizer for query tokenization', () => {
      const p = createPartitionIndex(0)

      const customTokenizer = {
        tokenize: (text: string) =>
          text.split(/\s+/).map((token, i) => ({
            token: token.toUpperCase(),
            position: i,
          })),
      }

      p.insert('ct1', { title: 'HELLO WORLD' }, schema, english, {
        customTokenizer,
      })

      const result = fulltextSearch(p, { term: 'hello world' }, english, schema, { customTokenizer })
      expect(result.totalMatched).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('handles single-character query terms', () => {
      const p = createPartitionIndex(0)
      p.insert('sc1', { title: 'x marks the spot' }, schema, english)

      const result = fulltextSearch(p, { term: 'x' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })

    it('handles documents with missing optional fields', () => {
      const p = createPartitionIndex(0)
      p.insert('sparse1', { title: 'sparse document' }, schema, english)

      const result = fulltextSearch(p, { term: 'sparse' }, english, schema)
      expect(result.totalMatched).toBe(1)
    })

    it('maintains descending score order after all filtering', () => {
      const result = fulltextSearch(
        partition,
        {
          term: 'brown dog fox',
          termMatch: 2,
          filters: { fields: { active: { eq: true } } },
        },
        english,
        schema,
      )
      for (let i = 1; i < result.scored.length; i++) {
        expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
      }
    })

    it('handles large tolerance values safely', () => {
      const result = fulltextSearch(partition, { term: 'fox', tolerance: 10 }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })

    it('handles unicode terms', () => {
      const p = createPartitionIndex(0)
      p.insert('uni1', { title: 'cafe resume' }, schema, english)
      p.insert('uni2', { title: 'caf\u00e9 r\u00e9sum\u00e9' }, schema, english)

      const result = fulltextSearch(p, { term: 'caf\u00e9' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })
  })
})
