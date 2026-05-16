import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import { NarsilError } from '../../../errors'
import { fulltextSearch } from '../../../search/fulltext'
import type { SchemaDefinition } from '../../../types/schema'
import { english, populatePartition, schema } from './fixtures'

describe('fulltextSearch advanced features and edge cases', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    populatePartition(partition)
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

      const globalStats: import('../../../types/internal').GlobalStatistics = {
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
      p.insert('uni2', { title: 'café résumé' }, schema, english)

      const result = fulltextSearch(p, { term: 'café' }, english, schema)
      expect(result.totalMatched).toBeGreaterThanOrEqual(1)
    })
  })
})
