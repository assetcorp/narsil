import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage } from '../../languages/registry'
import {
  collectGlobalStats,
  mergePartitionStats,
  pruneStatsToQueryTerms,
  setupStatisticsBroadcast,
} from '../../partitioning/distributed-scoring'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import type { InvalidationAdapter, InvalidationEvent } from '../../types/adapters'
import type { GlobalStatistics } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { CustomTokenizer, IndexConfig, SchemaDefinition } from '../../types/schema'

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

  describe('pruneStatsToQueryTerms', () => {
    const stemmedEnglish = getLanguage('english')

    const stats: GlobalStatistics = {
      totalDocuments: 1000,
      docFrequencies: { run: 40, shoe: 25, marathon: 90 },
      totalFieldLengths: { title: 5000 },
      averageFieldLengths: { title: 5 },
    }

    it('keeps only the frequencies of the analysed query tokens', () => {
      const pruned = pruneStatsToQueryTerms(stats, 'running shoes', stemmedEnglish, {})

      expect(pruned.docFrequencies).toEqual({ run: 40, shoe: 25 })
      expect(pruned.totalDocuments).toBe(1000)
      expect(pruned.totalFieldLengths).toEqual({ title: 5000 })
      expect(pruned.averageFieldLengths).toEqual({ title: 5 })
    })

    it('drops stop words the way scoring does', () => {
      const pruned = pruneStatsToQueryTerms(stats, 'the marathon', stemmedEnglish, {})
      expect(pruned.docFrequencies).toEqual({ marathon: 90 })
    })

    it('omits tokens absent from the statistics instead of writing zeroes', () => {
      const pruned = pruneStatsToQueryTerms(stats, 'marathon sprint', stemmedEnglish, {})
      expect(pruned.docFrequencies).toEqual({ marathon: 90 })
      expect('sprint' in pruned.docFrequencies).toBe(false)
    })

    it('applies the stop word override the index scores with', () => {
      const pruned = pruneStatsToQueryTerms(stats, 'marathon run', stemmedEnglish, {
        stopWords: new Set(['marathon']),
      })
      expect(pruned.docFrequencies).toEqual({ run: 40 })
    })

    it('splits with the custom tokenizer the index names', () => {
      const singleLetters: CustomTokenizer = {
        tokenize(text: string) {
          return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
        },
      }
      const letterStats: GlobalStatistics = {
        totalDocuments: 10,
        docFrequencies: { m: 4, x: 2, q: 7 },
        totalFieldLengths: { title: 50 },
        averageFieldLengths: { title: 5 },
      }
      const pruned = pruneStatsToQueryTerms(letterStats, 'mx', stemmedEnglish, {
        customTokenizer: singleLetters,
      })
      expect(pruned.docFrequencies).toEqual({ m: 4, x: 2 })
    })

    it('leaves the source statistics untouched', () => {
      pruneStatsToQueryTerms(stats, 'running', stemmedEnglish, {})
      expect(stats.docFrequencies).toEqual({ run: 40, shoe: 25, marathon: 90 })
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
