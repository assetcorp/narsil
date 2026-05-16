import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { indexConfig, schema } from './fixtures'

describe('Narsil document operations and management', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('getMultiple', () => {
    it('returns a Map of existing documents', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Item A', category: 'test', price: 10 }, 'a')
      await narsil.insert('products', { title: 'Item B', category: 'test', price: 20 }, 'b')

      const result = await narsil.getMultiple('products', ['a', 'b', 'nonexistent'])
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(2)
      expect(result.get('a')).toBeDefined()
      expect(result.get('b')).toBeDefined()
      expect(result.has('nonexistent')).toBe(false)
    })
  })

  describe('countDocuments', () => {
    it('returns the correct document count', async () => {
      await narsil.createIndex('products', indexConfig)

      const count0 = await narsil.countDocuments('products')
      expect(count0).toBe(0)

      await narsil.insert('products', { title: 'First', category: 'test', price: 1 })
      await narsil.insert('products', { title: 'Second', category: 'test', price: 2 })

      const count2 = await narsil.countDocuments('products')
      expect(count2).toBe(2)
    })
  })

  describe('clear', () => {
    it('empties the index without dropping it', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Temporary', category: 'test', price: 5 })

      const before = await narsil.countDocuments('products')
      expect(before).toBe(1)

      await narsil.clear('products')

      const after = await narsil.countDocuments('products')
      expect(after).toBe(0)

      const indexes = narsil.listIndexes()
      expect(indexes.map(i => i.name)).toContain('products')
    })
  })

  describe('getStats', () => {
    it('returns correct statistics for an index', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Widget', category: 'tools', price: 12 })
      await narsil.insert('products', { title: 'Gadget', category: 'tools', price: 24 })

      const stats = narsil.getStats('products')
      expect(stats.documentCount).toBe(2)
      expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
      expect(stats.language).toBe('english')
      expect(stats.schema).toEqual(schema)
    })
  })

  describe('listIndexes', () => {
    it('lists all created indexes with metadata', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.createIndex('users', {
        schema: { name: 'string' as const },
        language: 'english',
      })

      const indexes = narsil.listIndexes()
      expect(indexes.length).toBe(2)

      const names = indexes.map(i => i.name)
      expect(names).toContain('products')
      expect(names).toContain('users')

      const productsInfo = indexes.find(i => i.name === 'products')
      expect(productsInfo?.language).toBe('english')
    })
  })

  describe('dropIndex', () => {
    it('removes an index from the registry', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'To Drop', category: 'test', price: 1 })

      await narsil.dropIndex('products')

      const indexes = narsil.listIndexes()
      expect(indexes.map(i => i.name)).not.toContain('products')

      await expect(narsil.insert('products', { title: 'After Drop', category: 'test', price: 1 })).rejects.toThrow(
        NarsilError,
      )
    })
  })

  describe('duplicate index creation', () => {
    it('throws INDEX_ALREADY_EXISTS when creating a duplicate index', async () => {
      await narsil.createIndex('products', indexConfig)

      try {
        await narsil.createIndex('products', indexConfig)
        expect.fail('Expected an error for duplicate index creation')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.INDEX_ALREADY_EXISTS)
      }
    })
  })

  describe('getMemoryStats', () => {
    it('returns a valid memory stats structure', () => {
      const stats = narsil.getMemoryStats()
      expect(stats.totalBytes).toBe(0)
      expect(stats.workers).toEqual([])
    })
  })

  describe('custom docId', () => {
    it('uses a provided docId and validates it', async () => {
      await narsil.createIndex('products', indexConfig)

      const id = await narsil.insert('products', { title: 'Named Item', category: 'test', price: 42 }, 'my-custom-id')
      expect(id).toBe('my-custom-id')

      const doc = await narsil.get('products', 'my-custom-id')
      expect(doc?.title).toBe('Named Item')
    })

    it('rejects empty docId', async () => {
      await narsil.createIndex('products', indexConfig)

      await expect(narsil.insert('products', { title: 'No ID', category: 'test', price: 1 }, '')).rejects.toThrow(
        NarsilError,
      )
    })
  })

  describe('has', () => {
    it('returns true for existing documents and false for missing ones', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Existing', category: 'test', price: 1 }, 'exists')

      expect(await narsil.has('products', 'exists')).toBe(true)
      expect(await narsil.has('products', 'missing')).toBe(false)
    })
  })

  describe('removeBatch', () => {
    it('removes multiple documents and reports failures', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'One', category: 'test', price: 1 }, 'r1')
      await narsil.insert('products', { title: 'Two', category: 'test', price: 2 }, 'r2')

      const result = await narsil.removeBatch('products', ['r1', 'r2', 'nonexistent'])
      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].docId).toBe('nonexistent')
    })
  })

  describe('updateBatch', () => {
    it('updates multiple documents and reports failures', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Original One', category: 'test', price: 1 }, 'u1')
      await narsil.insert('products', { title: 'Original Two', category: 'test', price: 2 }, 'u2')

      const result = await narsil.updateBatch('products', [
        { docId: 'u1', document: { title: 'Updated One', category: 'test', price: 11 } },
        { docId: 'u2', document: { title: 'Updated Two', category: 'test', price: 22 } },
        { docId: 'missing', document: { title: 'Ghost', category: 'test', price: 0 } },
      ])

      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].docId).toBe('missing')

      const doc = await narsil.get('products', 'u1')
      expect(doc?.title).toBe('Updated One')
    })
  })
})
