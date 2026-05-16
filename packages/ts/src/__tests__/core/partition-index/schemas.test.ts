import { beforeEach, describe, expect, it } from 'vitest'
import type { PartitionIndex } from '../../../core/partition'
import type { SchemaDefinition } from '../../../types/schema'
import { english, makePartition } from './fixtures'

describe('PartitionIndex nested, geopoint, and array schemas', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = makePartition()
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
})
