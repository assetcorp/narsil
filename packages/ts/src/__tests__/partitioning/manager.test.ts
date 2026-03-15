import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../core/partition'
import { ErrorCodes, NarsilError } from '../../errors'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
}

const config: IndexConfig = {
  schema,
  language: 'english',
}

function makeManager(partitionCount = 1): PartitionManager {
  return createPartitionManager('test-index', config, english, createPartitionRouter(), partitionCount)
}

describe('PartitionManager', () => {
  let manager: PartitionManager

  beforeEach(() => {
    manager = makeManager(4)
  })

  describe('insert and retrieval', () => {
    it('inserts a document and retrieves it with get', () => {
      manager.insert('doc1', { title: 'hello world', body: 'content', price: 10 })
      expect(manager.has('doc1')).toBe(true)
      const retrieved = manager.get('doc1')
      expect(retrieved?.title).toBe('hello world')
    })

    it('routes the document to the correct partition', () => {
      manager.insert('doc1', { title: 'hello' })
      const router = createPartitionRouter()
      const expectedPid = router.route('doc1', 4)
      expect(manager.getPartition(expectedPid).has('doc1')).toBe(true)
    })

    it('returns undefined for a nonexistent document', () => {
      expect(manager.get('nonexistent')).toBeUndefined()
    })

    it('reports has() correctly for present and absent documents', () => {
      manager.insert('doc1', { title: 'present' })
      expect(manager.has('doc1')).toBe(true)
      expect(manager.has('doc2')).toBe(false)
    })
  })

  describe('remove', () => {
    it('removes a document from the correct partition', () => {
      manager.insert('doc1', { title: 'to be removed' })
      expect(manager.has('doc1')).toBe(true)
      manager.remove('doc1')
      expect(manager.has('doc1')).toBe(false)
      expect(manager.get('doc1')).toBeUndefined()
    })

    it('throws DOC_NOT_FOUND when removing a nonexistent document', () => {
      expect(() => manager.remove('ghost')).toThrow(NarsilError)
      try {
        manager.remove('ghost')
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_NOT_FOUND)
      }
    })
  })

  describe('update', () => {
    it('updates a document in the correct partition', () => {
      manager.insert('doc1', { title: 'original' })
      manager.update('doc1', { title: 'updated' })
      expect(manager.get('doc1')?.title).toBe('updated')
    })

    it('throws DOC_NOT_FOUND when updating a nonexistent document', () => {
      expect(() => manager.update('ghost', { title: 'nope' })).toThrow(NarsilError)
      try {
        manager.update('ghost', { title: 'nope' })
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_NOT_FOUND)
      }
    })
  })

  describe('countDocuments', () => {
    it('tracks the total document count across partitions', () => {
      expect(manager.countDocuments()).toBe(0)
      manager.insert('d1', { title: 'one' })
      manager.insert('d2', { title: 'two' })
      manager.insert('d3', { title: 'three' })
      expect(manager.countDocuments()).toBe(3)
      manager.remove('d2')
      expect(manager.countDocuments()).toBe(2)
    })
  })

  describe('getAggregateStats', () => {
    it('sums statistics across all partitions', () => {
      manager.insert('d1', { title: 'alpha beta', body: 'gamma' })
      manager.insert('d2', { title: 'beta delta', body: 'epsilon' })
      manager.insert('d3', { title: 'alpha zeta' })

      const stats = manager.getAggregateStats()
      expect(stats.totalDocuments).toBe(3)
      expect(Object.keys(stats.docFrequencies).length).toBeGreaterThan(0)
    })
  })

  describe('multiple partitions and distribution', () => {
    it('distributes documents across multiple partitions', () => {
      const mgr = makeManager(4)
      for (let i = 0; i < 100; i++) {
        mgr.insert(`doc-${i}`, { title: `title ${i}` })
      }
      expect(mgr.countDocuments()).toBe(100)

      let nonEmpty = 0
      for (const partition of mgr.getAllPartitions()) {
        if (partition.count() > 0) nonEmpty++
      }
      expect(nonEmpty).toBeGreaterThan(1)
    })
  })

  describe('getPartition', () => {
    it('returns the partition at a valid index', () => {
      const p = manager.getPartition(0)
      expect(p).toBeDefined()
      expect(p.partitionId).toBe(0)
    })

    it('throws INDEX_NOT_FOUND for a negative partition ID', () => {
      expect(() => manager.getPartition(-1)).toThrow(NarsilError)
      try {
        manager.getPartition(-1)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
      }
    })

    it('throws INDEX_NOT_FOUND for an out-of-bounds partition ID', () => {
      expect(() => manager.getPartition(99)).toThrow(NarsilError)
      try {
        manager.getPartition(99)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
      }
    })
  })

  describe('addPartition', () => {
    it('increases partitionCount by one', () => {
      const before = manager.partitionCount
      manager.addPartition()
      expect(manager.partitionCount).toBe(before + 1)
    })

    it('returns a usable new partition', () => {
      const newPartition = manager.addPartition()
      expect(newPartition.count()).toBe(0)
      newPartition.insert('manual-doc', { title: 'manual' }, schema, english)
      expect(newPartition.has('manual-doc')).toBe(true)
    })
  })

  describe('removePartition', () => {
    it('decreases partitionCount by one', () => {
      const before = manager.partitionCount
      manager.removePartition(before - 1)
      expect(manager.partitionCount).toBe(before - 1)
    })

    it('throws INDEX_NOT_FOUND for an out-of-bounds partition ID', () => {
      expect(() => manager.removePartition(100)).toThrow(NarsilError)
    })

    it('removes documents in the deleted partition from the doc map', () => {
      const mgr = makeManager(2)
      mgr.insert('doc-a', { title: 'alpha' })
      mgr.insert('doc-b', { title: 'beta' })

      const router = createPartitionRouter()
      const pidA = router.route('doc-a', 2)
      const pidB = router.route('doc-b', 2)

      if (pidA !== pidB) {
        mgr.removePartition(pidA)
        expect(mgr.has('doc-a')).toBe(false)
        expect(mgr.has('doc-b')).toBe(true)
      } else {
        mgr.removePartition(pidA)
        expect(mgr.has('doc-a')).toBe(false)
        expect(mgr.has('doc-b')).toBe(false)
      }
    })
  })

  describe('setPartitions', () => {
    it('replaces all partitions and rebuilds the document map', () => {
      const p0 = createPartitionIndex(0)
      const p1 = createPartitionIndex(1)
      p0.insert('ext-1', { title: 'from external' }, schema, english)
      p1.insert('ext-2', { title: 'from external too' }, schema, english)

      manager.setPartitions([p0, p1])
      expect(manager.partitionCount).toBe(2)
      expect(manager.has('ext-1')).toBe(true)
      expect(manager.has('ext-2')).toBe(true)
      expect(manager.countDocuments()).toBe(2)
    })
  })

  describe('serializePartition and deserializePartition', () => {
    it('round-trips a partition through serialization', () => {
      manager.insert('s-doc1', { title: 'serialize me', price: 42 })
      manager.insert('s-doc2', { title: 'serialize this', price: 99 })

      const router = createPartitionRouter()
      const pid1 = router.route('s-doc1', manager.partitionCount)

      const serialized = manager.serializePartition(pid1)
      expect(serialized.indexName).toBe('test-index')

      const freshManager = makeManager(4)
      freshManager.deserializePartition(pid1, serialized)

      expect(freshManager.has('s-doc1')).toBe(true)
      expect(freshManager.get('s-doc1')?.title).toBe('serialize me')
    })

    it('throws INDEX_NOT_FOUND for out-of-bounds serializePartition', () => {
      expect(() => manager.serializePartition(99)).toThrow(NarsilError)
    })

    it('throws INDEX_NOT_FOUND for out-of-bounds deserializePartition', () => {
      const data = manager.serializePartition(0)
      expect(() => manager.deserializePartition(99, data)).toThrow(NarsilError)
    })
  })

  describe('readonly properties', () => {
    it('exposes indexName, schema, language, and config', () => {
      expect(manager.indexName).toBe('test-index')
      expect(manager.schema).toBe(config.schema)
      expect(manager.language).toBe(english)
      expect(manager.config).toBe(config)
    })
  })

  describe('default partition count', () => {
    it('defaults to 1 partition when initialPartitionCount is omitted', () => {
      const mgr = createPartitionManager('default-mgr', config, english, createPartitionRouter())
      expect(mgr.partitionCount).toBe(1)
    })
  })
})
