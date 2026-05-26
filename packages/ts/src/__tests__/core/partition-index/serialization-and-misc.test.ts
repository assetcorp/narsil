import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import type { SchemaDefinition } from '../../../types/schema'
import { english, makePartition, simpleSchema } from './fixtures'

describe('PartitionIndex serialization and misc', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = makePartition()
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

    it('omits vector data from partition serialization', () => {
      const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[3]' }
      partition.insert('doc1', { title: 'one', embedding: [1, 0, 0] }, vectorSchema, english)

      const serialized = partition.serialize('test-index', 1, 'english', vectorSchema)
      expect(serialized.vectorData).toBeUndefined()

      const restored = makePartition(0)
      restored.deserialize(serialized, vectorSchema)

      expect(restored.count()).toBe(1)
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

    it('deserializes when schema has new fields not present in serialized data', () => {
      partition.insert('doc1', { title: 'hello world', price: 10 }, simpleSchema, english)
      const serialized = partition.serialize('test-index', 1, 'english', simpleSchema)

      const extendedSchema: SchemaDefinition = {
        ...simpleSchema,
        description: 'string',
        rating: 'number',
      }

      const restored = makePartition(0)
      expect(() => restored.deserialize(serialized, extendedSchema)).not.toThrow()
      expect(restored.count()).toBe(1)
      expect(restored.get('doc1')?.title).toBe('hello world')
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
})
