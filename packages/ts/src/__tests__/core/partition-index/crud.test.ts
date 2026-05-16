import { beforeEach, describe, expect, it } from 'vitest'
import type { PartitionIndex } from '../../../core/partition'
import { ErrorCodes, NarsilError } from '../../../errors'
import { english, makePartition, simpleSchema } from './fixtures'

describe('PartitionIndex CRUD operations', () => {
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
})
