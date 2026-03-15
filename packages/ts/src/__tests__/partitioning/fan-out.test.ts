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
    it('produces identical results to a direct partition search', () => {
      const manager = makeManager(1)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const params: QueryParams = { term: 'brown' }
      const fanOutConfig: FanOutConfig = { scoringMode: 'local' }
      const fanOutResult = fanOutQuery(manager, params, english, schema, fanOutConfig)

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

    it('finds all matching documents distributed across partitions', () => {
      const params: QueryParams = { term: 'brown' }
      const result = fanOutQuery(manager, params, english, schema, { scoringMode: 'local' })

      const matchingDocIds = result.scored.map(s => s.docId)
      expect(matchingDocIds).toContain('doc1')
      expect(matchingDocIds).toContain('doc2')
      expect(matchingDocIds).toContain('doc3')
      expect(matchingDocIds).toContain('doc5')
      expect(matchingDocIds).toContain('doc6')
      expect(matchingDocIds).not.toContain('doc4')
    })

    it('returns results sorted by descending score', () => {
      const result = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })

      for (let i = 1; i < result.scored.length; i++) {
        expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
      }
    })
  })

  describe('DFS mode', () => {
    it('uses global stats passed to search functions', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'brown bear roams', category: 'animals' })
      manager.insert('doc4', { title: 'search engine works', category: 'tech' })

      const localResult = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })
      const dfsResult = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'dfs' })

      expect(dfsResult.scored.length).toBe(localResult.scored.length)

      const dfsDocIds = dfsResult.scored.map(s => s.docId).sort()
      const localDocIds = localResult.scored.map(s => s.docId).sort()
      expect(dfsDocIds).toEqual(localDocIds)
    })
  })

  describe('broadcast mode', () => {
    it('uses pre-collected stats when provided', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const preCollectedStats = collectGlobalStats(manager)
      const broadcastResult = fanOutQuery(manager, { term: 'brown' }, english, schema, {
        scoringMode: 'broadcast',
        globalStats: preCollectedStats,
      })

      expect(broadcastResult.scored.length).toBeGreaterThan(0)
      const docIds = broadcastResult.scored.map(s => s.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).toContain('doc2')
    })

    it('falls back to DFS when no pre-collected stats are provided', () => {
      const manager = makeManager(3)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })
      manager.insert('doc2', { title: 'lazy brown dog', category: 'animals' })
      manager.insert('doc3', { title: 'search engine works', category: 'tech' })

      const dfsResult = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'dfs' })

      const broadcastNoStats = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'broadcast' })

      expect(broadcastNoStats.scored.length).toBe(dfsResult.scored.length)

      for (let i = 0; i < broadcastNoStats.scored.length; i++) {
        expect(broadcastNoStats.scored[i].docId).toBe(dfsResult.scored[i].docId)
        expect(broadcastNoStats.scored[i].score).toBeCloseTo(dfsResult.scored[i].score, 10)
      }
    })
  })

  describe('facet merging', () => {
    it('sums facet values correctly across partitions', () => {
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

      const result = fanOutQuery(manager, params, english, schema, { scoringMode: 'local' })

      expect(result.facets).toBeDefined()
      const facets = result.facets as NonNullable<typeof result.facets>
      expect(facets.category).toBeDefined()

      const categoryValues = facets.category.values
      const totalFaceted = Object.values(categoryValues).reduce((sum, count) => sum + count, 0)
      expect(totalFaceted).toBe(result.scored.length)
    })
  })

  describe('empty partitions', () => {
    it('handles all empty partitions gracefully', () => {
      const manager = makeManager(3)
      const result = fanOutQuery(manager, { term: 'anything' }, english, schema, { scoringMode: 'local' })

      expect(result.scored).toEqual([])
      expect(result.totalMatched).toBe(0)
    })

    it('handles a mix of empty and populated partitions', () => {
      const manager = makeManager(4)
      manager.insert('doc1', { title: 'quick brown fox', category: 'animals' })

      const result = fanOutQuery(manager, { term: 'brown' }, english, schema, { scoringMode: 'local' })

      expect(result.scored.length).toBe(1)
      expect(result.scored[0].docId).toBe('doc1')
    })
  })

  describe('vector search fan-out', () => {
    it('dispatches vector search when params.vector is set without a term', () => {
      const vectorSchema: SchemaDefinition = {
        title: 'string',
        embedding: 'vector[3]',
      }

      const vectorConfig: IndexConfig = { schema: vectorSchema, language: 'english' }
      const vectorManager = createPartitionManager('vector-index', vectorConfig, english, createPartitionRouter(), 2)

      vectorManager.insert('v1', { title: 'first vec', embedding: [1.0, 0.0, 0.0] })
      vectorManager.insert('v2', { title: 'second vec', embedding: [0.0, 1.0, 0.0] })
      vectorManager.insert('v3', { title: 'third vec', embedding: [0.0, 0.0, 1.0] })

      const params: QueryParams = {
        vector: {
          field: 'embedding',
          value: [1.0, 0.0, 0.0],
          metric: 'cosine',
        },
        limit: 10,
      }

      const result = fanOutQuery(vectorManager, params, english, vectorSchema, { scoringMode: 'local' })

      expect(result.scored.length).toBeGreaterThan(0)
      expect(result.scored[0].docId).toBe('v1')
    })
  })

  describe('hybrid search fan-out', () => {
    it('dispatches hybrid search when both term and vector are present', () => {
      const hybridSchema: SchemaDefinition = {
        title: 'string',
        embedding: 'vector[3]',
      }

      const hybridConfig: IndexConfig = { schema: hybridSchema, language: 'english' }
      const hybridManager = createPartitionManager('hybrid-index', hybridConfig, english, createPartitionRouter(), 2)

      hybridManager.insert('h1', { title: 'quick brown fox', embedding: [1.0, 0.0, 0.0] })
      hybridManager.insert('h2', { title: 'lazy brown dog', embedding: [0.0, 1.0, 0.0] })
      hybridManager.insert('h3', { title: 'search engine works', embedding: [0.0, 0.0, 1.0] })

      const params: QueryParams = {
        term: 'brown',
        vector: {
          field: 'embedding',
          value: [1.0, 0.0, 0.0],
          metric: 'cosine',
        },
        mode: 'hybrid',
        limit: 10,
      }

      const result = fanOutQuery(hybridManager, params, english, hybridSchema, { scoringMode: 'local' })

      expect(result.scored.length).toBeGreaterThan(0)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('h1')
    })
  })
})
