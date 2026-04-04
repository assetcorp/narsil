import { beforeEach, describe, expect, it } from 'vitest'
import { collectGlobalStats } from '../../partitioning/distributed-scoring'
import { type FanOutConfig, fanOutQuery } from '../../partitioning/fan-out'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import { fulltextSearch } from '../../search/fulltext'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { QueryParams } from '../../types/search'

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

describe('fanOutQuery', () => {
  describe('single partition', () => {
    it('produces identical results to a direct partition search', async () => {
      const manager = makeManager(1)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const params: QueryParams = { term: 'brown' }
      const fanOutConfig: FanOutConfig = { scoringMode: 'local' }
      const fanOutResult = await fanOutQuery(manager, params, english, schema, fanOutConfig)

      const partition = manager.getPartition(0)
      const directResult = fulltextSearch(partition, params, english, schema)

      expect(fanOutResult.scored.length).toBe(directResult.scored.length)
      expect(fanOutResult.totalMatched).toBe(directResult.totalMatched)

      for (let i = 0; i < fanOutResult.scored.length; i++) {
        expect(fanOutResult.scored[i].docId).toBe(directResult.scored[i].docId)
        expect(fanOutResult.scored[i].score).toBeCloseTo(directResult.scored[i].score, 10)
      }
    })
  })

  describe('three partitions', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'brown bear roams', category: 'animals' })
      manager.insert('doc4', { title: 'search engine works', category: 'tech' })
      manager.insert('doc5', { title: 'fast brown rabbit', category: 'animals' })
      manager.insert('doc6', { title: 'brown eagle soars', category: 'animals' })
    })

    it('finds all matching documents distributed across partitions', async () => {
      const params: QueryParams = { term: 'brown' }
      const result = await fanOutQuery(manager, params, english, schema, { scoringMode: 'local' })

      const matchingDocIds = result.scored.map(s => s.docId)
      expect(matchingDocIds).toContain('doc1')
      expect(matchingDocIds).toContain('doc2')
      expect(matchingDocIds).toContain('doc3')
      expect(matchingDocIds).toContain('doc5')
      expect(matchingDocIds).toContain('doc6')
      expect(matchingDocIds).not.toContain('doc4')
    })

    it('returns results sorted by descending score', async () => {
      const result = await fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })

      for (let i = 1; i < result.scored.length; i++) {
        expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
      }
    })
  })

  describe('DFS mode', () => {
    it('uses global stats passed to search functions', async () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'brown bear roams', category: 'animals' })
      manager.insert('doc4', { title: 'search engine works', category: 'tech' })

      const localResult = await fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })
      const dfsResult = await fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'dfs' })

      expect(dfsResult.scored.length).toBe(localResult.scored.length)

      const dfsDocIds = dfsResult.scored.map(s => s.docId).sort()
      const localDocIds = localResult.scored.map(s => s.docId).sort()
      expect(dfsDocIds).toEqual(localDocIds)

      const localScoreMap = new Map(localResult.scored.map(s => [s.docId, s.score]))
      const dfsScoreMap = new Map(dfsResult.scored.map(s => [s.docId, s.score]))
      let scoresDiffer = false
      for (const [docId, localScore] of localScoreMap) {
        const dfsScore = dfsScoreMap.get(docId)
        if (dfsScore !== undefined && Math.abs(localScore - dfsScore) > 1e-10) {
          scoresDiffer = true
          break
        }
      }
      if (manager.partitionCount > 1 && dfsResult.scored.length > 0) {
        expect(scoresDiffer).toBe(true)
      }
    })
  })

  describe('broadcast mode', () => {
    it('uses pre-collected stats when provided', async () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const preCollectedStats = collectGlobalStats(manager)
      const broadcastResult = await fanOutQuery(manager, { term: 'brown' }, english, schema, {
        scoringMode: 'broadcast',
        globalStats: preCollectedStats,
      })

      expect(broadcastResult.scored.length).toBeGreaterThan(0)
      const docIds = broadcastResult.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc2')
    })

    it('falls back to DFS when no pre-collected stats are provided', async () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const dfsResult = await fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'dfs' })

      const broadcastNoStats = await fanOutQuery(manager, { term: 'brown' }, english, schema, {
        scoringMode: 'broadcast',
      })

      expect(broadcastNoStats.scored.length).toBe(dfsResult.scored.length)

      for (let i = 0; i < broadcastNoStats.scored.length; i++) {
        expect(broadcastNoStats.scored[i].docId).toBe(dfsResult.scored[i].docId)
        expect(broadcastNoStats.scored[i].score).toBeCloseTo(dfsResult.scored[i].score, 10)
      }
    })
  })

  describe('facet merging', () => {
    it('sums facet values correctly across partitions', async () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'brown bear roams', category: 'animals' })
      manager.insert('doc4', { title: 'brown engine search', category: 'tech' })
      manager.insert('doc5', { title: 'fast brown rabbit', category: 'animals' })

      const params: QueryParams = {
        term: 'brown',
        facets: { category: {} },
      }

      const result = await fanOutQuery(manager, params, english, schema, { scoringMode: 'local' })

      expect(result.facets).toBeDefined()
      const facets = result.facets as NonNullable<typeof result.facets>
      expect(facets.category).toBeDefined()

      const categoryValues = facets.category.values
      const totalFaceted = Object.values(categoryValues).reduce((sum, count) => sum + count, 0)
      expect(totalFaceted).toBe(result.scored.length)
    })
  })

  describe('empty partitions', () => {
    it('handles all empty partitions gracefully', async () => {
      const manager = makeManager(3)
      const result = await fanOutQuery(manager, { term: 'anything' }, english, schema, { scoringMode: 'local' })

      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('handles a mix of empty and populated partitions', async () => {
      const manager = makeManager(4)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })

      const result = await fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })

      expect(result.scored.length).toBe(1)
      expect(result.scored[0].docId).toBe('doc1')
    })
  })

})
