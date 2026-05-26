import { beforeEach, describe, expect, it } from 'vitest'
import type { FanOutResult } from '../../../partitioning/fan-out'
import type { SerializablePartition } from '../../../types/internal'
import type { SchemaDefinition } from '../../../types/schema'
import { createDirectExecutor, type DirectExecutorExtensions } from '../../../workers/direct-executor'
import type { Executor } from '../../../workers/executor'
import { config, reqId, schema } from './fixtures'

describe('DirectExecutor', () => {
  let executor: Executor & DirectExecutorExtensions

  beforeEach(() => {
    executor = createDirectExecutor()
  })

  describe('query', () => {
    it('dispatches to fan-out and returns matching results', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-1',
        document: { title: 'quick brown fox', score: 10 },
        requestId: reqId(),
      })
      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-2',
        document: { title: 'lazy brown dog', score: 20 },
        requestId: reqId(),
      })
      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-3',
        document: { title: 'search engine', score: 30 },
        requestId: reqId(),
      })

      const result = await executor.execute<FanOutResult>({
        type: 'query',
        indexName: 'products',
        params: { term: 'brown' },
        requestId: reqId(),
      })

      expect(result.scored.length).toBe(2)
      const docIds = result.scored.map(s => s.docId)
      expect(docIds).toContain('doc-1')
      expect(docIds).toContain('doc-2')
      expect(result.totalMatched).toBe(2)
    })
  })

  describe('preflight', () => {
    it('returns the count of matching documents without full results', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-1',
        document: { title: 'quick brown fox', score: 10 },
        requestId: reqId(),
      })
      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-2',
        document: { title: 'lazy brown dog', score: 20 },
        requestId: reqId(),
      })

      const result = await executor.execute<{ count: number }>({
        type: 'preflight',
        indexName: 'products',
        params: { term: 'brown' },
        requestId: reqId(),
      })

      expect(result.count).toBe(2)
    })
  })

  describe('getStats', () => {
    it('returns accurate index statistics', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-1',
        document: { title: 'item one', score: 10 },
        requestId: reqId(),
      })
      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-2',
        document: { title: 'item two', score: 20 },
        requestId: reqId(),
      })

      const stats = await executor.execute<{
        documentCount: number
        partitionCount: number
        language: string
        schema: SchemaDefinition
      }>({
        type: 'getStats',
        indexName: 'products',
        requestId: reqId(),
      })

      expect(stats.documentCount).toBe(2)
      expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
      expect(stats.language).toBe('english')
      expect(stats.schema).toEqual(schema)
    })
  })

  describe('serialize and deserialize', () => {
    it('round-trips a partition through serialization', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-1',
        document: { title: 'serializable item', score: 42 },
        requestId: reqId(),
      })

      const serialized = await executor.execute<SerializablePartition>({
        type: 'serialize',
        indexName: 'products',
        partitionId: 0,
        requestId: reqId(),
      })

      expect(serialized.indexName).toBe('products')

      await executor.execute({ type: 'createIndex', indexName: 'products-clone', config, requestId: reqId() })

      await executor.execute({
        type: 'deserialize',
        indexName: 'products-clone',
        partitionId: 0,
        data: serialized,
        requestId: reqId(),
      })

      const doc = await executor.execute<Record<string, unknown> | undefined>({
        type: 'get',
        indexName: 'products-clone',
        docId: 'doc-1',
        requestId: reqId(),
      })

      expect(doc).toBeDefined()
      expect(doc?.title).toBe('serializable item')
      expect(doc?.score).toBe(42)
    })
  })

  describe('listIndexes', () => {
    it('returns all created index names', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'alpha', config, requestId: reqId() })
      await executor.execute({ type: 'createIndex', indexName: 'beta', config, requestId: reqId() })
      await executor.execute({ type: 'createIndex', indexName: 'gamma', config, requestId: reqId() })

      const names = executor.listIndexes()
      expect(names).toContain('alpha')
      expect(names).toContain('beta')
      expect(names).toContain('gamma')
      expect(names.length).toBe(3)
    })
  })

  describe('getManager', () => {
    it('returns the PartitionManager for a created index', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })
      const manager = executor.getManager('products')
      expect(manager).toBeDefined()
      expect(manager?.indexName).toBe('products')
    })

    it('returns undefined for a nonexistent index', () => {
      expect(executor.getManager('nonexistent')).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('empties the index without removing it', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'products', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: 'doc-1',
        document: { title: 'keep the index', score: 1 },
        requestId: reqId(),
      })

      let count = await executor.execute<number>({
        type: 'count',
        indexName: 'products',
        requestId: reqId(),
      })
      expect(count).toBe(1)

      await executor.execute({ type: 'clear', indexName: 'products', requestId: reqId() })

      count = await executor.execute<number>({
        type: 'count',
        indexName: 'products',
        requestId: reqId(),
      })
      expect(count).toBe(0)

      expect(executor.listIndexes()).toContain('products')
    })
  })

  describe('shutdown', () => {
    it('clears all indexes and removes them', async () => {
      await executor.execute({ type: 'createIndex', indexName: 'alpha', config, requestId: reqId() })
      await executor.execute({ type: 'createIndex', indexName: 'beta', config, requestId: reqId() })

      await executor.execute({
        type: 'insert',
        indexName: 'alpha',
        docId: 'doc-1',
        document: { title: 'data', score: 1 },
        requestId: reqId(),
      })

      await executor.shutdown()

      expect(executor.listIndexes()).toEqual([])
    })
  })

  describe('memoryReport', () => {
    it('returns an object with memory information', async () => {
      const report = await executor.execute<Record<string, unknown>>({
        type: 'memoryReport',
        requestId: reqId(),
      })

      expect(typeof report).toBe('object')
      expect(report).not.toBeNull()
    })
  })
})
