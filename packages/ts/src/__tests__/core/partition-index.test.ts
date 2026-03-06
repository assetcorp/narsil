import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

const simpleSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
  active: 'boolean',
  category: 'enum',
}

function makePartition(id = 0): PartitionIndex {
  return createPartitionIndex(id)
}

describe('PartitionIndex', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = makePartition()
  })

  describe('insert', () => {
    it('stores a document and updates count', () => {
      partition.insert(
        'doc1',
        { title: 'hello world', body: 'content', price: 10, active: true, category: 'books' },
        simpleSchema,
        english,
      )
      expect(partition.count()).toBe(1)
      expect(partition.has('doc1')).toBe(true)
    })

    it('throws DOC_ALREADY_EXISTS for duplicate IDs', () => {
      partition.insert('doc1', { title: 'hello' }, simpleSchema, english)
      expect(() => {
        partition.insert('doc1', { title: 'world' }, simpleSchema, english)
      }).toThrow(NarsilError)
      try {
        partition.insert('doc1', { title: 'world' }, simpleSchema, english)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_ALREADY_EXISTS)
      }
    })

    it('validates documents against schema by default', () => {
      expect(() => {
        partition.insert('doc1', { title: 123 as unknown as string }, simpleSchema, english)
      }).toThrow(NarsilError)
    })

    it('skips validation when validate is false', () => {
      partition.insert('doc1', { title: 'valid text', price: 99 }, simpleSchema, english, { validate: false })
      expect(partition.has('doc1')).toBe(true)
      expect(partition.get('doc1')?.price).toBe(99)
    })

    it('handles optional fields (missing fields are allowed)', () => {
      partition.insert('doc1', { title: 'only title' }, simpleSchema, english)
      expect(partition.count()).toBe(1)
    })

    it('updates statistics after insert', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      expect(partition.stats.totalDocuments).toBe(1)
    })
  })

  describe('remove', () => {
    it('removes a stored document', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      partition.remove('doc1', simpleSchema, english)
      expect(partition.count()).toBe(0)
      expect(partition.has('doc1')).toBe(false)
    })

    it('throws DOC_NOT_FOUND for missing documents', () => {
      expect(() => {
        partition.remove('nonexistent', simpleSchema, english)
      }).toThrow(NarsilError)
      try {
        partition.remove('nonexistent', simpleSchema, english)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_NOT_FOUND)
      }
    })

    it('updates statistics after remove', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      partition.remove('doc1', simpleSchema, english)
      expect(partition.stats.totalDocuments).toBe(0)
    })

    it('removes tokens from the inverted index', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      const resultBefore = partition.searchFulltext({ queryTokens: [{ token: 'hello', position: 0 }] })
      expect(resultBefore.totalMatched).toBe(1)

      partition.remove('doc1', simpleSchema, english)
      const resultAfter = partition.searchFulltext({ queryTokens: [{ token: 'hello', position: 0 }] })
      expect(resultAfter.totalMatched).toBe(0)
    })
  })

  describe('update', () => {
    it('updates a document in place', () => {
      partition.insert('doc1', { title: 'hello world', price: 10 }, simpleSchema, english)
      partition.update('doc1', { title: 'hello world', price: 20 }, simpleSchema, english)
      const doc = partition.get('doc1')
      expect(doc?.price).toBe(20)
    })

    it('throws DOC_NOT_FOUND if document does not exist', () => {
      expect(() => {
        partition.update('nonexistent', { title: 'test' }, simpleSchema, english)
      }).toThrow(NarsilError)
    })

    it('uses fast path when only non-text fields change', () => {
      partition.insert('doc1', { title: 'hello world', price: 10, active: true }, simpleSchema, english)
      partition.update('doc1', { title: 'hello world', price: 50, active: false }, simpleSchema, english)

      const doc = partition.get('doc1')
      expect(doc?.price).toBe(50)
      expect(doc?.active).toBe(false)

      const result = partition.searchFulltext({ queryTokens: [{ token: 'hello', position: 0 }] })
      expect(result.totalMatched).toBe(1)
    })

    it('creates field index for previously-undefined fields via fast path', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      partition.update('doc1', { title: 'hello world', price: 42 }, simpleSchema, english)

      const result = partition.applyFilters({ fields: { price: { eq: 42 } } }, simpleSchema)
      expect(result.size).toBe(1)
      expect(result.has('doc1')).toBe(true)
    })

    it('re-indexes text when text fields change', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      partition.update('doc1', { title: 'goodbye universe' }, simpleSchema, english)

      const helloResult = partition.searchFulltext({ queryTokens: [{ token: 'hello', position: 0 }] })
      expect(helloResult.totalMatched).toBe(0)

      const goodbyeResult = partition.searchFulltext({ queryTokens: [{ token: 'goodbye', position: 0 }] })
      expect(goodbyeResult.totalMatched).toBe(1)
    })
  })

  describe('get / has', () => {
    it('returns a deep copy of the document', () => {
      const original = { title: 'hello', price: 10 }
      partition.insert('doc1', original, simpleSchema, english)
      const retrieved = partition.get('doc1')
      expect(retrieved?.title).toBe('hello')
      if (retrieved) {
        ;(retrieved as Record<string, unknown>).title = 'mutated'
      }
      expect(partition.get('doc1')?.title).toBe('hello')
    })

    it('returns undefined for missing documents', () => {
      expect(partition.get('nonexistent')).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('removes all documents and resets state', () => {
      partition.insert('doc1', { title: 'hello' }, simpleSchema, english)
      partition.insert('doc2', { title: 'world' }, simpleSchema, english)
      partition.clear()
      expect(partition.count()).toBe(0)
      expect(partition.stats.totalDocuments).toBe(0)
    })
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

  describe('nested schema', () => {
    const nestedSchema: SchemaDefinition = {
      metadata: {
        author: 'string',
        rating: 'number',
      },
      title: 'string',
    }

    it('indexes and searches nested string fields', () => {
      partition.insert('doc1', { title: 'book', metadata: { author: 'tolkien', rating: 5 } }, nestedSchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'tolkien', position: 0 }],
      })
      expect(result.totalMatched).toBe(1)
    })

    it('filters on nested numeric fields', () => {
      partition.insert('doc1', { title: 'a', metadata: { author: 'one', rating: 3 } }, nestedSchema, english)
      partition.insert('doc2', { title: 'b', metadata: { author: 'two', rating: 5 } }, nestedSchema, english)

      const result = partition.applyFilters(
        {
          fields: { 'metadata.rating': { gte: 4 } },
        },
        nestedSchema,
      )
      expect(result.size).toBe(1)
      expect(result.has('doc2')).toBe(true)
    })
  })

  describe('geopoint fields', () => {
    const geoSchema: SchemaDefinition = {
      name: 'string',
      location: 'geopoint',
    }

    it('indexes and filters geopoint fields by radius', () => {
      partition.insert('nyc', { name: 'new york', location: { lat: 40.7128, lon: -74.006 } }, geoSchema, english)
      partition.insert('la', { name: 'los angeles', location: { lat: 34.0522, lon: -118.2437 } }, geoSchema, english)
      partition.insert('london', { name: 'london', location: { lat: 51.5074, lon: -0.1278 } }, geoSchema, english)

      const result = partition.applyFilters(
        {
          fields: {
            location: {
              radius: { lat: 40.7128, lon: -74.006, distance: 500, unit: 'km', inside: true },
            },
          },
        },
        geoSchema,
      )

      expect(result.has('nyc')).toBe(true)
      expect(result.has('la')).toBe(false)
    })
  })

  describe('vector fields', () => {
    const vectorSchema: SchemaDefinition = {
      title: 'string',
      embedding: 'vector[3]',
    }

    it('indexes and searches vector fields', () => {
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)
      partition.insert('doc2', { title: 'two', embedding: [0, 1, 0] }, vectorSchema, english)
      partition.insert('doc3', { title: 'three', embedding: [1, 0.1, 0] }, vectorSchema, english)

      const result = partition.searchVector({
        field: 'embedding',
        value: [1, 0, 0],
        k: 2,
        metric: 'cosine',
      })

      expect(result.totalMatched).toBe(2)
      expect(result.scored[0].docId).toBe('doc1')
    })

    it('throws for mismatched vector dimensions', () => {
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)
      expect(() => {
        partition.searchVector({
          field: 'embedding',
          value: [1, 0],
          k: 1,
          metric: 'cosine',
        })
      }).toThrow(NarsilError)
    })

    it('filters vector results by similarity threshold', () => {
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)
      partition.insert('doc2', { title: 'two', embedding: [0, 1, 0] }, vectorSchema, english)

      const result = partition.searchVector({
        field: 'embedding',
        value: [1, 0, 0],
        k: 10,
        similarity: 0.9,
        metric: 'cosine',
      })

      expect(result.scored.length).toBe(1)
      expect(result.scored[0].docId).toBe('doc1')
    })

    it('returns empty results for non-existent vector field', () => {
      const result = partition.searchVector({
        field: 'nonexistent',
        value: [1, 0, 0],
        k: 10,
        metric: 'cosine',
      })
      expect(result.totalMatched).toBe(0)
    })
  })

  describe('array fields', () => {
    const arraySchema: SchemaDefinition = {
      title: 'string',
      tags: 'string[]',
      scores: 'number[]',
      flags: 'boolean[]',
      labels: 'enum[]',
    }

    it('indexes string array fields for fulltext search', () => {
      partition.insert('doc1', { title: 'test', tags: ['machine', 'learning'] }, arraySchema, english)
      const result = partition.searchFulltext({
        queryTokens: [{ token: 'machine', position: 0 }],
      })
      expect(result.totalMatched).toBe(1)
    })

    it('removes string array tokens on document removal', () => {
      partition.insert('doc1', { title: 'test', tags: ['machine', 'learning'] }, arraySchema, english)
      partition.remove('doc1', arraySchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'machine', position: 0 }],
      })
      expect(result.totalMatched).toBe(0)
    })

    it('re-indexes inverted index when string[] field changes on update', () => {
      partition.insert('doc1', { title: 'test', tags: ['machine', 'learning'] }, arraySchema, english)
      partition.update('doc1', { title: 'test', tags: ['deep', 'neural'] }, arraySchema, english)

      const oldResult = partition.searchFulltext({
        queryTokens: [{ token: 'machine', position: 0 }],
      })
      expect(oldResult.totalMatched).toBe(0)

      const newResult = partition.searchFulltext({
        queryTokens: [{ token: 'deep', position: 0 }],
      })
      expect(newResult.totalMatched).toBe(1)
      expect(newResult.scored[0].docId).toBe('doc1')
    })

    it('aggregates term frequency across string[] items', () => {
      partition.insert('doc1', { title: 'test', tags: ['machine learning', 'machine vision'] }, arraySchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'machine', position: 0 }],
      })
      expect(result.totalMatched).toBe(1)
      expect(result.scored[0].termFrequencies['tags:machine']).toBe(2)
    })

    it('uses total token count as field length for string[]', () => {
      partition.insert('doc1', { title: 'test', tags: ['hello world', 'foo bar baz'] }, arraySchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'hello', position: 0 }],
      })
      expect(result.scored[0].fieldLengths.tags).toBe(5)
    })
  })

  describe('serialize / deserialize', () => {
    it('round-trips all index data', () => {
      partition.insert(
        'doc1',
        { title: 'hello world', price: 10, active: true, category: 'books' },
        simpleSchema,
        english,
      )
      partition.insert(
        'doc2',
        { title: 'search engine', price: 20, active: false, category: 'tech' },
        simpleSchema,
        english,
      )

      const serialized = partition.serialize('test-index', 4, 'english', simpleSchema)

      expect(serialized.indexName).toBe('test-index')
      expect(serialized.partitionId).toBe(0)
      expect(serialized.totalPartitions).toBe(4)
      expect(serialized.language).toBe('english')
      expect(serialized.docCount).toBe(2)

      const newPartition = makePartition(0)
      newPartition.deserialize(serialized, simpleSchema)

      expect(newPartition.count()).toBe(2)
      expect(newPartition.has('doc1')).toBe(true)
      expect(newPartition.has('doc2')).toBe(true)
      expect(newPartition.get('doc1')?.title).toBe('hello world')
      expect(newPartition.get('doc2')?.price).toBe(20)
    })

    it('preserves search capability after deserialization', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      const serialized = partition.serialize('test-index', 1, 'english', simpleSchema)

      const restored = makePartition(0)
      restored.deserialize(serialized, simpleSchema)

      const result = restored.searchFulltext({
        queryTokens: [{ token: 'hello', position: 0 }],
      })
      expect(result.totalMatched).toBe(1)
      expect(result.scored[0].docId).toBe('doc1')
    })

    it('preserves filter capability after deserialization', () => {
      partition.insert('doc1', { title: 'one', price: 10 }, simpleSchema, english)
      partition.insert('doc2', { title: 'two', price: 20 }, simpleSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', simpleSchema)
      const restored = makePartition(0)
      restored.deserialize(serialized, simpleSchema)

      const result = restored.applyFilters({ fields: { price: { gte: 15 } } }, simpleSchema)
      expect(result.size).toBe(1)
      expect(result.has('doc2')).toBe(true)
    })

    it('preserves statistics after deserialization', () => {
      partition.insert('doc1', { title: 'hello world' }, simpleSchema, english)
      partition.insert('doc2', { title: 'search engine' }, simpleSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', simpleSchema)
      const restored = makePartition(0)
      restored.deserialize(serialized, simpleSchema)

      expect(restored.stats.totalDocuments).toBe(2)
    })

    it('preserves vector data after deserialization', () => {
      const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[3]' }
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', vectorSchema)
      const restored = makePartition(0)
      restored.deserialize(serialized, vectorSchema)

      const result = restored.searchVector({
        field: 'embedding',
        value: [1, 0, 0],
        k: 1,
        metric: 'cosine',
      })
      expect(result.totalMatched).toBe(1)
    })

    it('round-trips documents and tokens with __proto__ as key', () => {
      partition.insert('__proto__', { title: '__proto__' }, simpleSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', simpleSchema)

      const restored = makePartition(0)
      restored.deserialize(serialized, simpleSchema)

      expect(restored.has('__proto__')).toBe(true)
      expect(restored.get('__proto__')?.title).toBe('__proto__')

      const result = restored.searchFulltext({
        queryTokens: [{ token: '__proto__', position: 0 }],
      })
      expect(result.totalMatched).toBe(1)
    })

    it('preserves geopoint data after deserialization', () => {
      const geoSchema: SchemaDefinition = { name: 'string', location: 'geopoint' }
      partition.insert('nyc', { name: 'new york', location: { lat: 40.7128, lon: -74.006 } }, geoSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', geoSchema)
      const restored = makePartition(0)
      restored.deserialize(serialized, geoSchema)

      const result = restored.applyFilters(
        {
          fields: {
            location: {
              radius: { lat: 40.7128, lon: -74.006, distance: 10, unit: 'km', inside: true },
            },
          },
        },
        geoSchema,
      )
      expect(result.has('nyc')).toBe(true)
    })
  })

  describe('partitionId', () => {
    it('exposes the partition ID', () => {
      const p = createPartitionIndex(42)
      expect(p.partitionId).toBe(42)
    })
  })

  describe('stop words', () => {
    it('removes stop words during indexing', () => {
      partition.insert('doc1', { title: 'the quick brown fox' }, simpleSchema, english)
      const theResult = partition.searchFulltext({
        queryTokens: [{ token: 'the', position: 0 }],
      })
      expect(theResult.totalMatched).toBe(0)

      const foxResult = partition.searchFulltext({
        queryTokens: [{ token: 'fox', position: 0 }],
      })
      expect(foxResult.totalMatched).toBe(1)
    })
  })

  describe('multiple documents scoring', () => {
    it('ranks documents with higher term frequency higher', () => {
      partition.insert('doc1', { title: 'search' }, simpleSchema, english)
      partition.insert('doc2', { title: 'search search search' }, simpleSchema, english)

      const result = partition.searchFulltext({
        queryTokens: [{ token: 'search', position: 0 }],
      })

      expect(result.scored.length).toBe(2)
      expect(result.scored[0].docId).toBe('doc2')
    })
  })

  describe('euclidean vector metric', () => {
    const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[2]' }

    it('returns results using euclidean distance', () => {
      partition.insert('doc1', { title: 'close', embedding: [1.0, 0.0] }, vectorSchema, english)
      partition.insert('doc2', { title: 'far', embedding: [10.0, 10.0] }, vectorSchema, english)

      const result = partition.searchVector({
        field: 'embedding',
        value: [1.0, 0.0],
        k: 2,
        metric: 'euclidean',
      })

      expect(result.scored[0].docId).toBe('doc1')
      expect(result.scored[0].score).toBeGreaterThan(result.scored[1].score)
    })
  })

  describe('dotProduct vector metric', () => {
    const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[3]' }

    it('returns results using dot product', () => {
      partition.insert('doc1', { title: 'aligned', embedding: [1, 1, 1] }, vectorSchema, english)
      partition.insert('doc2', { title: 'orthogonal', embedding: [0, 0, 1] }, vectorSchema, english)

      const result = partition.searchVector({
        field: 'embedding',
        value: [1, 1, 0],
        k: 2,
        metric: 'dotProduct',
      })

      expect(result.scored[0].docId).toBe('doc1')
    })
  })

  describe('vector search with filter doc IDs', () => {
    const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[3]' }

    it('restricts vector search to provided doc IDs', () => {
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)
      partition.insert('doc2', { title: 'two', embedding: [0.9, 0.1, 0] }, vectorSchema, english)
      partition.insert('doc3', { title: 'three', embedding: [0, 1, 0] }, vectorSchema, english)

      const result = partition.searchVector({
        field: 'embedding',
        value: [1, 0, 0],
        k: 10,
        metric: 'cosine',
        filterDocIds: new Set(['doc2', 'doc3']),
      })

      expect(result.scored.every(s => s.docId !== 'doc1')).toBe(true)
    })
  })
})
