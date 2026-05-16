import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'
import { indexConfig, schema } from './fixtures'

describe('Narsil rebalance, partitioning, and strict mode', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('rebalance', () => {
    it('rebalances from 1 partition to 4 with all docs searchable', async () => {
      const config: IndexConfig = { schema, language: 'english', partitions: { maxPartitions: 1 } }
      await narsil.createIndex('products', config)

      for (let i = 0; i < 50; i++) {
        await narsil.insert('products', { title: `Wireless Device ${i}`, category: 'electronics', price: i * 10 })
      }

      await narsil.rebalance('products', 4)

      expect(narsil.getStats('products').partitionCount).toBe(4)
      expect(await narsil.countDocuments('products')).toBe(50)

      const result = await narsil.query('products', { term: 'wireless' })
      expect(result.count).toBe(50)
    })

    it('rejects concurrent rebalance on same index', async () => {
      await narsil.createIndex('products', indexConfig)
      const rebalancePromise = narsil.rebalance('products', 3)
      await expect(narsil.rebalance('products', 5)).rejects.toThrow(NarsilError)
      await rebalancePromise
    })

    it('no-ops when target count equals current count', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.rebalance('products', 1)
      expect(narsil.getStats('products').partitionCount).toBe(1)
    })
  })

  describe('updatePartitionConfig', () => {
    it('rejects reducing capacity below current doc count', async () => {
      const config: IndexConfig = {
        schema,
        language: 'english',
        partitions: { maxDocsPerPartition: 100, maxPartitions: 2 },
      }
      await narsil.createIndex('products', config)

      for (let i = 0; i < 20; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'test', price: i })
      }

      await expect(
        narsil.updatePartitionConfig('products', { maxDocsPerPartition: 5, maxPartitions: 1 }),
      ).rejects.toThrow(NarsilError)
    })

    it('accepts increasing capacity', async () => {
      const config: IndexConfig = {
        schema,
        language: 'english',
        partitions: { maxDocsPerPartition: 10, maxPartitions: 1 },
      }
      await narsil.createIndex('products', config)
      await narsil.updatePartitionConfig('products', { maxDocsPerPartition: 100 })
    })
  })

  describe('strict mode', () => {
    it('rejects insert with extra fields', async () => {
      const strictConfig: IndexConfig = { schema, language: 'english', strict: true }
      narsil = await createNarsil()
      await narsil.createIndex('strict', strictConfig)

      await expect(
        narsil.insert('strict', { title: 'Laptop', category: 'tech', price: 999, brand: 'Acme' }),
      ).rejects.toThrow(NarsilError)
    })

    it('allows matching fields in strict mode', async () => {
      const strictConfig: IndexConfig = { schema, language: 'english', strict: true }
      narsil = await createNarsil()
      await narsil.createIndex('strict', strictConfig)

      const id = await narsil.insert('strict', { title: 'Laptop', category: 'tech', price: 999 })
      expect(id).toBeTruthy()
    })

    it('allows extra fields in default (permissive) mode', async () => {
      await narsil.createIndex('products', indexConfig)

      const id = await narsil.insert('products', {
        title: 'Laptop',
        category: 'tech',
        price: 999,
        brand: 'Acme',
        color: 'silver',
      })
      expect(id).toBeTruthy()
    })

    it('reports partial failures in strict batch insert', async () => {
      const strictConfig: IndexConfig = { schema, language: 'english', strict: true }
      narsil = await createNarsil()
      await narsil.createIndex('strict', strictConfig)

      const result = await narsil.insertBatch('strict', [
        { title: 'Valid', category: 'a', price: 10 },
        { title: 'Invalid', category: 'b', price: 20, extraField: 'oops' },
        { title: 'Also Valid', category: 'c', price: 30 },
      ])

      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
    })

    it('rejects update with extra fields', async () => {
      const strictConfig: IndexConfig = { schema, language: 'english', strict: true }
      narsil = await createNarsil()
      await narsil.createIndex('strict', strictConfig)

      const id = await narsil.insert('strict', { title: 'Laptop', category: 'tech', price: 999 })
      await expect(
        narsil.update('strict', id, { title: 'Updated', category: 'tech', price: 1099, brand: 'New' }),
      ).rejects.toThrow(NarsilError)
    })
  })

  describe('memory estimation', () => {
    it('returns positive memoryBytes after inserting documents', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Wireless Headphones', category: 'electronics', price: 99 })
      await narsil.insert('products', { title: 'Bluetooth Speaker', category: 'electronics', price: 49 })

      const stats = narsil.getStats('products')
      expect(stats.memoryBytes).toBeGreaterThan(0)
      expect(stats.indexSizeBytes).toBeGreaterThan(0)
    })

    it('returns zero memoryBytes for an empty index', async () => {
      await narsil.createIndex('products', indexConfig)
      const stats = narsil.getStats('products')
      expect(stats.memoryBytes).toBe(0)
    })

    it('tracks memory decrease after removes', async () => {
      await narsil.createIndex('products', indexConfig)
      const ids: string[] = []
      for (let i = 0; i < 50; i++) {
        ids.push(await narsil.insert('products', { title: `Product ${i}`, category: 'test', price: i }))
      }

      const memAfterInsert = narsil.getStats('products').memoryBytes
      for (let i = 0; i < 25; i++) {
        await narsil.remove('products', ids[i])
      }
      expect(narsil.getStats('products').memoryBytes).toBeLessThan(memAfterInsert)
    })
  })

  describe('getPartitionStats', () => {
    it('returns per-partition breakdown', async () => {
      const config: IndexConfig = { schema, language: 'english', partitions: { maxPartitions: 3 } }
      await narsil.createIndex('products', config)

      for (let i = 0; i < 30; i++) {
        await narsil.insert('products', { title: `Product ${i}`, category: 'electronics', price: i })
      }

      const partitionStats = narsil.getPartitionStats('products')
      expect(partitionStats.length).toBe(3)

      let totalDocs = 0
      for (const ps of partitionStats) {
        expect(ps.documentCount).toBeGreaterThanOrEqual(0)
        expect(ps.estimatedMemoryBytes).toBeGreaterThanOrEqual(0)
        totalDocs += ps.documentCount
      }
      expect(totalDocs).toBe(30)
    })

    it('is consistent with getStats memoryBytes', async () => {
      await narsil.createIndex('products', { schema, language: 'english', partitions: { maxPartitions: 3 } })

      for (let i = 0; i < 30; i++) {
        await narsil.insert('products', { title: `Product ${i}`, category: 'electronics', price: i * 10 })
      }

      const stats = narsil.getStats('products')
      const partitionStats = narsil.getPartitionStats('products')
      const partitionSum = partitionStats.reduce((sum, ps) => sum + ps.estimatedMemoryBytes, 0)
      expect(stats.memoryBytes).toBe(partitionSum)
    })
  })
})
