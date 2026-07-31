import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage } from '../../languages/registry'
import {
  collectGlobalStats,
  collectQueryTermStats,
  mergePartitionStats,
  pruneStatsToQueryTerms,
  sanitizeGlobalStats,
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
  revision: '1',
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

  describe('Object.prototype key safety', () => {
    it('sums a df key named constructor numerically in mergePartitionStats', () => {
      const merged = mergePartitionStats([
        { totalDocuments: 2, docFrequencies: { constructor: 1 }, totalFieldLengths: { title: 10 } },
        { totalDocuments: 3, docFrequencies: { constructor: 2 }, totalFieldLengths: { title: 15 } },
      ])
      expect(merged.docFrequencies.constructor).toBe(3)
      expect(typeof merged.docFrequencies.constructor).toBe('number')
    })

    it('aggregates a document containing the word constructor into numeric stats', () => {
      const manager = makeManager(2)
      manager.insert('doc1', { title: 'constructor of engines', category: 'tech' })
      manager.insert('doc2', { title: 'engine constructor guide', category: 'tech' })

      const aggregate = manager.getAggregateStats()
      expect(aggregate.docFrequencies.constructor).toBe(2)
      expect(typeof aggregate.docFrequencies.constructor).toBe('number')
    })

    it('never copies an inherited key into pruned statistics, keeping them clonable', () => {
      const stats = {
        totalDocuments: 10,
        docFrequencies: { machin: 4 },
        totalFieldLengths: { title: 50 },
        averageFieldLengths: { title: 5 },
      }
      const pruned = pruneStatsToQueryTerms(stats, 'constructor __proto__ machine', getLanguage('english'), {})

      expect(Object.hasOwn(pruned.docFrequencies, 'constructor')).toBe(false)
      expect(Object.hasOwn(pruned.docFrequencies, '__proto__')).toBe(false)
      expect(pruned.docFrequencies.machin).toBe(4)
      expect(() => structuredClone(pruned)).not.toThrow()
    })

    it('sanitizes wire statistics down to finite numeric own entries', () => {
      const dirty = {
        totalDocuments: Number.NaN,
        docFrequencies: { machine: 4, broken: 'text', infinite: Infinity } as unknown as Record<string, number>,
        totalFieldLengths: { title: 50 },
        averageFieldLengths: { title: 5 },
      }
      const clean = sanitizeGlobalStats(dirty)

      expect(clean.totalDocuments).toBe(0)
      expect(clean.docFrequencies).toEqual({ machine: 4 })
      expect(Object.hasOwn(clean.docFrequencies, 'broken')).toBe(false)
      expect(Object.hasOwn(clean.docFrequencies, 'infinite')).toBe(false)
      expect(clean.totalFieldLengths).toEqual({ title: 50 })
    })
  })

  describe('collectQueryTermStats', () => {
    it('collects frequencies for the analysed query tokens alone', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'alpha beta gamma', category: 'animals' })
      manager.insert('doc2', { title: 'beta delta epsilon', category: 'tech' })
      manager.insert('doc3', { title: 'alpha zeta', category: 'animals' })

      const stats = collectQueryTermStats(manager, 'alpha beta', english, {})

      expect(stats.docFrequencies).toEqual({ alpha: 2, beta: 2 })
      expect(stats.totalDocuments).toBe(3)
    })

    it('matches the full aggregate on totals, averages, and shared term frequencies', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'alpha beta gamma', category: 'animals' })
      manager.insert('doc2', { title: 'beta delta epsilon', category: 'tech' })
      manager.insert('doc3', { title: 'alpha zeta', category: 'animals' })
      manager.insert('doc4', { title: 'gamma theta', category: 'science' })

      const full = collectGlobalStats(manager)
      const scoped = collectQueryTermStats(manager, 'alpha gamma', english, {})

      expect(scoped.totalDocuments).toBe(full.totalDocuments)
      expect(scoped.totalFieldLengths).toEqual(full.totalFieldLengths)
      expect(scoped.averageFieldLengths).toEqual(full.averageFieldLengths)
      expect(scoped.docFrequencies.alpha).toBe(full.docFrequencies.alpha)
      expect(scoped.docFrequencies.gamma).toBe(full.docFrequencies.gamma)
      expect(Object.keys(scoped.docFrequencies).sort()).toEqual(['alpha', 'gamma'])
    })

    it('drops stop words and deduplicates repeated tokens', () => {
      const manager = makeManager(2)
      manager.insert('doc1', { title: 'alpha alpha the beta', category: 'tech' })

      const stats = collectQueryTermStats(manager, 'the alpha alpha alpha', english, {})

      expect(stats.docFrequencies).toEqual({ alpha: 1 })
    })

    it('omits query tokens absent from every partition', () => {
      const manager = makeManager(2)
      manager.insert('doc1', { title: 'alpha beta', category: 'tech' })

      const stats = collectQueryTermStats(manager, 'alpha missing', english, {})

      expect(stats.docFrequencies).toEqual({ alpha: 1 })
      expect(Object.hasOwn(stats.docFrequencies, 'missing')).toBe(false)
    })

    it('reads a constructor token as a number, never the inherited property', () => {
      const manager = makeManager(2)
      manager.insert('doc1', { title: 'constructor patterns', category: 'tech' })

      const stats = collectQueryTermStats(manager, 'constructor', english, {})

      expect(stats.docFrequencies.constructor).toBe(1)
      expect(typeof stats.docFrequencies.constructor).toBe('number')
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
