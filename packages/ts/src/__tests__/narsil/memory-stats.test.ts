import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexStats, MemoryStats, PartitionStatsResult } from '../../types/results'
import { indexConfig, schema } from './fixtures'

const SAMPLE_DOC_COUNT = 100

function ensureProcessMemoryAvailable(stats: MemoryStats): NonNullable<MemoryStats['process']> {
  if (stats.process === null) {
    throw new Error('process memory unavailable in this runtime; memory-stats tests require Node-like host')
  }
  return stats.process
}

describe('Narsil memory reporting', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('getMemoryStats process measurements', () => {
    it('reports a process snapshot whose heapUsed grows with inserts', async () => {
      await narsil.createIndex('products', indexConfig)

      const before = await narsil.getMemoryStats()
      const beforeProcess = ensureProcessMemoryAvailable(before)
      expect(beforeProcess.heapUsed).toBeGreaterThan(0)
      expect(beforeProcess.heapTotal).toBeGreaterThanOrEqual(beforeProcess.heapUsed)
      expect(beforeProcess.rss).toBeGreaterThan(0)
      expect(beforeProcess.external).toBeGreaterThanOrEqual(0)

      for (let i = 0; i < SAMPLE_DOC_COUNT; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }

      const after = await narsil.getMemoryStats()
      const afterProcess = ensureProcessMemoryAvailable(after)
      expect(afterProcess.heapUsed).toBeGreaterThanOrEqual(beforeProcess.heapUsed)
    })

    it('is the same order of magnitude as process.memoryUsage().heapUsed', async () => {
      const stats = await narsil.getMemoryStats()
      const processStats = ensureProcessMemoryAvailable(stats)
      const direct = process.memoryUsage()

      const ratio = processStats.heapUsed / direct.heapUsed
      expect(ratio).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(2)
    })

    it('returns empty workers list when not promoted', async () => {
      const stats = await narsil.getMemoryStats()
      expect(stats.workers).toEqual([])
    })

    it('reports zero estimatedIndexBytes for an engine with no indexes', async () => {
      const stats = await narsil.getMemoryStats()
      expect(stats.estimatedIndexBytes).toBe(0)
    })
  })

  describe('getMemoryStats estimatedIndexBytes', () => {
    it('grows monotonically as documents are inserted', async () => {
      await narsil.createIndex('products', indexConfig)

      const empty = (await narsil.getMemoryStats()).estimatedIndexBytes
      expect(empty).toBe(0)

      for (let i = 0; i < 50; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }
      const half = (await narsil.getMemoryStats()).estimatedIndexBytes
      expect(half).toBeGreaterThan(empty)

      for (let i = 50; i < SAMPLE_DOC_COUNT; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }
      const full = (await narsil.getMemoryStats()).estimatedIndexBytes
      expect(full).toBeGreaterThan(half)
    })

    it('matches the sum of per-index estimatedMemoryBytes across all indexes', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.createIndex('orders', { schema, language: 'english' })

      for (let i = 0; i < 25; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
        await narsil.insert('orders', { title: `Order ${i}`, category: 'standard', price: i })
      }

      const memory = await narsil.getMemoryStats()
      const productsStats = narsil.getStats('products')
      const ordersStats = narsil.getStats('orders')
      expect(memory.estimatedIndexBytes).toBe(productsStats.estimatedMemoryBytes + ordersStats.estimatedMemoryBytes)
    })
  })

  describe('getStats estimatedMemoryBytes', () => {
    it('grows monotonically as documents are inserted into the index', async () => {
      await narsil.createIndex('products', indexConfig)

      const empty = narsil.getStats('products').estimatedMemoryBytes
      expect(empty).toBe(0)

      for (let i = 0; i < SAMPLE_DOC_COUNT; i++) {
        await narsil.insert('products', { title: `Title ${i}`, category: 'electronics', price: i })
      }
      const grown = narsil.getStats('products').estimatedMemoryBytes
      expect(grown).toBeGreaterThan(empty)
    })
  })

  describe('getPartitionStats estimatedMemoryBytes', () => {
    it('grows monotonically as documents are inserted into a partition', async () => {
      await narsil.createIndex('products', { schema, language: 'english', partitions: { maxPartitions: 1 } })

      const initial = narsil.getPartitionStats('products')
      expect(initial.length).toBe(1)
      expect(initial[0].estimatedMemoryBytes).toBe(0)

      for (let i = 0; i < 50; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }
      const halfway = narsil.getPartitionStats('products')
      const halfwayPartition = halfway.find(p => p.partitionId === 0)
      if (!halfwayPartition) throw new Error('partition 0 missing after 50 inserts')
      expect(halfwayPartition.estimatedMemoryBytes).toBeGreaterThan(initial[0].estimatedMemoryBytes)

      for (let i = 50; i < SAMPLE_DOC_COUNT; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }
      const full = narsil.getPartitionStats('products')
      const fullPartition = full.find(p => p.partitionId === 0)
      if (!fullPartition) throw new Error('partition 0 missing after final inserts')
      expect(fullPartition.estimatedMemoryBytes).toBeGreaterThan(halfwayPartition.estimatedMemoryBytes)
    })

    it('partition estimatedMemoryBytes is the formula sum exposed by getStats', async () => {
      await narsil.createIndex('products', { schema, language: 'english', partitions: { maxPartitions: 4 } })

      for (let i = 0; i < SAMPLE_DOC_COUNT; i++) {
        await narsil.insert('products', { title: `Item ${i}`, category: 'electronics', price: i })
      }
      const partitions = narsil.getPartitionStats('products')
      const sum = partitions.reduce((acc, p) => acc + p.estimatedMemoryBytes, 0)
      expect(narsil.getStats('products').estimatedMemoryBytes).toBe(sum)
    })
  })

  describe('memory type contracts', () => {
    it('IndexStats exposes estimatedMemoryBytes and does not expose memoryBytes or indexSizeBytes', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Sample', category: 'a', price: 1 })

      const stats: IndexStats = narsil.getStats('products')
      expect(typeof stats.estimatedMemoryBytes).toBe('number')
      const dynamicStats = stats as unknown as Record<string, unknown>
      expect('memoryBytes' in dynamicStats).toBe(false)
      expect('indexSizeBytes' in dynamicStats).toBe(false)
    })

    it('PartitionStatsResult exposes estimatedMemoryBytes per partition', async () => {
      await narsil.createIndex('products', { schema, language: 'english', partitions: { maxPartitions: 2 } })
      await narsil.insert('products', { title: 'Sample', category: 'a', price: 1 })

      const partitions: PartitionStatsResult[] = narsil.getPartitionStats('products')
      expect(partitions.length).toBe(2)
      for (const partition of partitions) {
        expect(typeof partition.estimatedMemoryBytes).toBe('number')
      }
    })

    it('MemoryStats exposes process measurements and estimatedIndexBytes, not totalBytes', async () => {
      const stats: MemoryStats = await narsil.getMemoryStats()
      expect(typeof stats.estimatedIndexBytes).toBe('number')
      expect(stats.process === null || typeof stats.process === 'object').toBe(true)
      const dynamicStats = stats as unknown as Record<string, unknown>
      expect('totalBytes' in dynamicStats).toBe(false)
    })
  })
})
