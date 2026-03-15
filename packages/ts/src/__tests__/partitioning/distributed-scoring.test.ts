import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectGlobalStats,
  mergePartitionStats,
  setupStatisticsBroadcast,
} from '../../partitioning/distributed-scoring'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import type { InvalidationAdapter, InvalidationEvent } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

const schema: SchemaDefinition = {
  title: 'string',
  category: 'enum',
}

const config: IndexConfig = {
  schema,
  language: 'english',
}

function makeManager(partitionCount = 3): PartitionManager {
  return createPartitionManager('test-index', config, english, createPartitionRouter(), partitionCount)
}

describe('distributed-scoring', () => {
  describe('collectGlobalStats', () => {
    it('sums statistics correctly across multiple partitions', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'alpha beta gamma', category: 'animals' })
      manager.insert('doc2', { title: 'beta delta epsilon', category: 'tech' })
      manager.insert('doc3', { title: 'alpha zeta', category: 'animals' })
      manager.insert('doc4', { title: 'gamma theta', category: 'science' })

      const stats = collectGlobalStats(manager)

      expect(stats.totalDocuments).toBe(4)
      expect(Object.keys(stats.docFrequencies).length).toBeGreaterThan(0)
      expect(Object.keys(stats.totalFieldLengths).length).toBeGreaterThan(0)
      expect(Object.keys(stats.averageFieldLengths).length).toBeGreaterThan(0)

      for (const [field, avg] of Object.entries(stats.averageFieldLengths)) {
        const expectedAvg = stats.totalFieldLengths[field] / stats.totalDocuments
        expect(avg).toBeCloseTo(expectedAvg, 10)
      }
    })

    it('returns zeroed averages when there are 0 documents', () => {
      const manager = makeManager(3)
      const stats = collectGlobalStats(manager)

      expect(stats.totalDocuments).toBe(0)
      expect(stats.docFrequencies).toEqual({})
      expect(stats.totalFieldLengths).toEqual({})
      expect(stats.averageFieldLengths).toEqual({})
    })
  })

  describe('mergePartitionStats', () => {
    it('produces the same results as collectGlobalStats', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'alpha beta gamma', category: 'animals' })
      manager.insert('doc2', { title: 'beta delta epsilon', category: 'tech' })
      manager.insert('doc3', { title: 'alpha zeta', category: 'animals' })
      manager.insert('doc4', { title: 'gamma theta', category: 'science' })

      const fromCollect = collectGlobalStats(manager)

      const partitions = manager.getAllPartitions()
      const statsArray = partitions.map(p => ({
        totalDocuments: p.stats.totalDocuments,
        docFrequencies: { ...p.stats.docFrequencies },
        totalFieldLengths: { ...p.stats.totalFieldLengths },
      }))

      const fromMerge = mergePartitionStats(statsArray)

      expect(fromMerge.totalDocuments).toBe(fromCollect.totalDocuments)
      expect(fromMerge.docFrequencies).toEqual(fromCollect.docFrequencies)
      expect(fromMerge.totalFieldLengths).toEqual(fromCollect.totalFieldLengths)
      expect(fromMerge.averageFieldLengths).toEqual(fromCollect.averageFieldLengths)
    })

    it('handles an empty stats array', () => {
      const result = mergePartitionStats([])
      expect(result.totalDocuments).toBe(0)
      expect(result.docFrequencies).toEqual({})
      expect(result.totalFieldLengths).toEqual({})
      expect(result.averageFieldLengths).toEqual({})
    })

    it('merges overlapping doc frequencies by summing', () => {
      const result = mergePartitionStats([
        { totalDocuments: 5, docFrequencies: { fox: 3, dog: 2 }, totalFieldLengths: { title: 25 } },
        { totalDocuments: 3, docFrequencies: { fox: 1, cat: 2 }, totalFieldLengths: { title: 15 } },
      ])

      expect(result.totalDocuments).toBe(8)
      expect(result.docFrequencies.fox).toBe(4)
      expect(result.docFrequencies.dog).toBe(2)
      expect(result.docFrequencies.cat).toBe(2)
      expect(result.totalFieldLengths.title).toBe(40)
      expect(result.averageFieldLengths.title).toBe(5)
    })
  })

  describe('setupStatisticsBroadcast', () => {
    let manager: PartitionManager

    beforeEach(() => {
      vi.useFakeTimers()
      manager = makeManager(2)
      manager.insert('doc1', { title: 'broadcast test alpha', category: 'tech' })
      manager.insert('doc2', { title: 'broadcast test beta', category: 'science' })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('publishes events at the specified interval', async () => {
      const published: InvalidationEvent[] = []
      const adapter: InvalidationAdapter = {
        publish: async event => {
          published.push(event)
        },
        subscribe: async () => {},
        shutdown: async () => {},
      }

      const handle = setupStatisticsBroadcast(manager, adapter, 'instance-1', 1000)

      await vi.advanceTimersByTimeAsync(1000)
      expect(published.length).toBe(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(published.length).toBe(2)

      await vi.advanceTimersByTimeAsync(1000)
      expect(published.length).toBe(3)

      const event = published[0]
      expect(event.type).toBe('statistics')
      if (event.type === 'statistics') {
        expect(event.indexName).toBe('test-index')
        expect(event.instanceId).toBe('instance-1')
        expect(event.stats.totalDocs).toBe(2)
        expect(Object.keys(event.stats.docFrequencies).length).toBeGreaterThan(0)
      }

      handle.shutdown()
    })

    it('stops broadcasting after shutdown', async () => {
      const published: InvalidationEvent[] = []
      const adapter: InvalidationAdapter = {
        publish: async event => {
          published.push(event)
        },
        subscribe: async () => {},
        shutdown: async () => {},
      }

      const handle = setupStatisticsBroadcast(manager, adapter, 'instance-2', 500)

      await vi.advanceTimersByTimeAsync(500)
      expect(published.length).toBe(1)

      handle.shutdown()

      await vi.advanceTimersByTimeAsync(2000)
      expect(published.length).toBe(1)
    })
  })
})
