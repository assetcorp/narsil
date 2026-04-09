import { encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import { createReplicationLog } from '../../../distribution/replication/log'
import {
  applyDeleteEntry,
  applyIndexEntry,
  setNestedValue,
  validateReplicationEntry,
} from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'

const testLanguage: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are']),
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

function makeManager() {
  return createPartitionManager('test-index', config, testLanguage, createPartitionRouter(), 1)
}

function makeLogEntry(overrides?: Partial<ReplicationLogEntry>): ReplicationLogEntry {
  const log = createReplicationLog(0)
  const entry = log.append({
    primaryTerm: overrides?.primaryTerm ?? 1,
    operation: overrides?.operation ?? 'INDEX',
    partitionId: overrides?.partitionId ?? 0,
    indexName: overrides?.indexName ?? 'test-index',
    documentId: overrides?.documentId ?? 'doc-001',
    document: overrides?.document ?? encode({ title: 'Wireless Headphones', body: 'Great audio', price: 149 }),
  })
  return entry
}

function createMockVectorIndex(dimension: number): VectorIndex {
  const vectors = new Map<string, Float32Array>()
  return {
    insert: vi.fn((docId: string, vector: Float32Array) => {
      vectors.set(docId, vector)
    }),
    remove: vi.fn((docId: string) => {
      vectors.delete(docId)
    }),
    scheduleBuild: vi.fn(),
    awaitPendingBuild: vi.fn(async () => {}),
    dispose: vi.fn(),
    search: vi.fn(() => []),
    getVector: vi.fn((docId: string) => vectors.get(docId) ?? null),
    has: vi.fn((docId: string) => vectors.has(docId)),
    compact: vi.fn(),
    optimize: vi.fn(async () => {}),
    maintenanceStatus: vi.fn(() => ({
      tombstoneRatio: 0,
      graphCount: 0,
      bufferSize: 0,
      building: false,
      estimatedCompactMs: 0,
      estimatedOptimizeMs: 0,
    })),
    estimateMemoryBytes: vi.fn(() => 0),
    serialize: vi.fn(() => ({ fieldName: 'embedding', dimension, vectors: [], graphs: [], sq8: null })),
    deserialize: vi.fn(),
    size: 0,
    dimension,
    fieldName: 'embedding',
  }
}

describe('validateReplicationEntry', () => {
  it('returns valid for a correct entry with matching term', () => {
    const log = createReplicationLog(0)
    const entry = log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'doc-001',
      document: encode({ title: 'Test' }),
    })

    const result = validateReplicationEntry(entry, 1, log)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns invalid with REPLICATION_ENTRY_CORRUPT for bad checksum', () => {
    const log = createReplicationLog(0)
    const entry = log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'doc-001',
      document: encode({ title: 'Test' }),
    })

    const tampered = { ...entry, documentId: 'tampered-id' }
    const result = validateReplicationEntry(tampered, 1, log)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('REPLICATION_ENTRY_CORRUPT')
  })

  it('returns invalid with REPLICATION_TERM_MISMATCH for stale primaryTerm', () => {
    const log = createReplicationLog(0)
    const entry = log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'doc-001',
      document: encode({ title: 'Test' }),
    })

    const result = validateReplicationEntry(entry, 5, log)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('REPLICATION_TERM_MISMATCH')
  })

  it('reports corruption before term mismatch when both fail', () => {
    const log = createReplicationLog(0)
    const entry = log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'doc-001',
      document: encode({ title: 'Test' }),
    })

    const tampered = { ...entry, documentId: 'tampered' }
    const result = validateReplicationEntry(tampered, 5, log)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('REPLICATION_ENTRY_CORRUPT')
  })
})

describe('applyIndexEntry', () => {
  it('inserts a document into the partition manager', () => {
    const manager = makeManager()
    const entry = makeLogEntry()

    applyIndexEntry(entry, manager, new Set(), new Map())

    expect(manager.has('doc-001')).toBe(true)
    const doc = manager.get('doc-001')
    expect(doc).toBeDefined()
    expect((doc as Record<string, unknown>).title).toBe('Wireless Headphones')
  })

  it('applies an INDEX entry with vector fields', () => {
    const vecIndex = createMockVectorIndex(3)
    const vecIndexes = new Map([['embedding', vecIndex]])
    const vectorFieldPaths = new Set(['embedding'])

    const vectorData = new Float32Array([1.0, 2.0, 3.0])
    const document = { title: 'Test doc', body: 'Content', price: 10, embedding: vectorData }
    const encoded = encode(document)

    const entry = makeLogEntry({ document: encoded })
    applyIndexEntry(entry, makeManager(), vectorFieldPaths, vecIndexes)

    expect(vecIndex.insert).toHaveBeenCalled()
    expect(vecIndex.scheduleBuild).toHaveBeenCalled()
  })

  it('replaces an existing document on INDEX (update semantics)', () => {
    const manager = makeManager()
    const vecIndexes = new Map<string, VectorIndex>()

    const entry1 = makeLogEntry({
      document: encode({ title: 'Original Title', body: 'content', price: 100 }),
    })
    applyIndexEntry(entry1, manager, new Set(), vecIndexes)
    expect(manager.has('doc-001')).toBe(true)

    const entry2 = makeLogEntry({
      document: encode({ title: 'Updated Title', body: 'new content', price: 200 }),
    })
    applyIndexEntry(entry2, manager, new Set(), vecIndexes)

    const doc = manager.get('doc-001') as Record<string, unknown>
    expect(doc.title).toBe('Updated Title')
    expect(doc.price).toBe(200)
  })

  it('does nothing when document field is null', () => {
    const manager = makeManager()
    const entry: ReplicationLogEntry = {
      seqNo: 1,
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'test-index',
      documentId: 'doc-001',
      document: null,
      checksum: 0,
    }

    applyIndexEntry(entry, manager, new Set(), new Map())
    expect(manager.has('doc-001')).toBe(false)
  })

  it('round-trips Float32Array through msgpack encode/decode', () => {
    const vecIndex = createMockVectorIndex(4)
    const vecIndexes = new Map([['embedding', vecIndex]])
    const vectorFieldPaths = new Set(['embedding'])

    const originalVector = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const document = { title: 'Vector doc', body: 'has vectors', price: 50, embedding: originalVector }
    const encoded = encode(document)

    const entry = makeLogEntry({ document: encoded })
    const manager = makeManager()
    applyIndexEntry(entry, manager, vectorFieldPaths, vecIndexes)

    expect(vecIndex.insert).toHaveBeenCalledTimes(1)
    const insertCall = vi.mocked(vecIndex.insert).mock.calls[0]
    const insertedVector = insertCall[1]
    expect(insertedVector).toBeInstanceOf(Float32Array)
    expect(insertedVector.length).toBe(4)
    expect(Math.abs(insertedVector[0] - 0.1)).toBeLessThan(0.001)
    expect(Math.abs(insertedVector[1] - 0.2)).toBeLessThan(0.001)
    expect(Math.abs(insertedVector[2] - 0.3)).toBeLessThan(0.001)
    expect(Math.abs(insertedVector[3] - 0.4)).toBeLessThan(0.001)
  })
})

describe('applyDeleteEntry', () => {
  it('removes an existing document from the partition manager', () => {
    const manager = makeManager()
    manager.insert('doc-001', { title: 'Test', body: 'content', price: 10 })
    expect(manager.has('doc-001')).toBe(true)

    const entry = makeLogEntry({ operation: 'DELETE', document: null })
    applyDeleteEntry(entry, manager, new Map())

    expect(manager.has('doc-001')).toBe(false)
  })

  it('removes vectors when deleting a document', () => {
    const vecIndex = createMockVectorIndex(3)
    const vecIndexes = new Map([['embedding', vecIndex]])
    const manager = makeManager()

    manager.insert('doc-001', { title: 'Test', body: 'content', price: 10 })

    const entry = makeLogEntry({ operation: 'DELETE', document: null })
    applyDeleteEntry(entry, manager, vecIndexes)

    expect(vecIndex.remove).toHaveBeenCalledWith('doc-001')
  })

  it('is idempotent for non-existent documents', () => {
    const manager = makeManager()
    const entry = makeLogEntry({
      operation: 'DELETE',
      document: null,
      documentId: 'nonexistent-doc',
    })

    expect(() => applyDeleteEntry(entry, manager, new Map())).not.toThrow()
  })
})

describe('setNestedValue prototype pollution guard', () => {
  it('rejects __proto__ as a top-level key', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, '__proto__', { polluted: true })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(obj.__proto__).toBe(Object.prototype)
  })

  it('rejects constructor as a top-level key', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, 'constructor', 'malicious')
    expect(obj.constructor).toBe(Object)
  })

  it('rejects prototype as a top-level key', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, 'prototype', 'malicious')
    expect(Object.hasOwn(obj, 'prototype')).toBe(false)
  })

  it('rejects __proto__ as an intermediate path segment', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, '__proto__.polluted', true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects constructor in a nested path', () => {
    const obj: Record<string, unknown> = { nested: {} }
    setNestedValue(obj, 'nested.constructor.polluted', true)
    expect(Object.hasOwn(obj, 'polluted')).toBe(false)
  })

  it('rejects prototype as a final path segment', () => {
    const obj: Record<string, unknown> = { nested: {} }
    setNestedValue(obj, 'nested.prototype', 'malicious')
    const nested = obj.nested as Record<string, unknown>
    expect(Object.hasOwn(nested, 'prototype')).toBe(false)
  })

  it('sets legitimate nested values correctly', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, 'a.b.c', 42)
    expect((obj.a as Record<string, unknown>).b).toEqual({ c: 42 })
  })

  it('sets top-level values correctly', () => {
    const obj: Record<string, unknown> = {}
    setNestedValue(obj, 'name', 'Narsil')
    expect(obj.name).toBe('Narsil')
  })
})

describe('applyIndexEntry atomic rollback on vector failure', () => {
  it('rolls back the document when vector insertion fails', () => {
    const failingVecIndex = createMockVectorIndex(3)
    vi.mocked(failingVecIndex.insert).mockImplementation(() => {
      throw new Error('Vector capacity exceeded')
    })
    const vecIndexes = new Map([['embedding', failingVecIndex]])
    const vectorFieldPaths = new Set(['embedding'])

    const vectorData = new Float32Array([1.0, 2.0, 3.0])
    const document = { title: 'Test doc', body: 'Content', price: 10, embedding: vectorData }
    const encoded = encode(document)
    const entry = makeLogEntry({ document: encoded })
    const manager = makeManager()

    expect(() => applyIndexEntry(entry, manager, vectorFieldPaths, vecIndexes)).toThrow('Vector capacity exceeded')
    expect(manager.has('doc-001')).toBe(false)
  })
})

describe('restoreVectorFields non-4-aligned byte length', () => {
  it('throws when a vector field has byte length not divisible by 4', () => {
    const vecIndexes = new Map<string, VectorIndex>()
    const vectorFieldPaths = new Set(['embedding'])

    const badBytes = new Uint8Array([1, 2, 3, 4, 5])
    const document = { title: 'Bad vector doc', body: 'content', price: 10, embedding: badBytes }
    const encoded = encode(document)
    const entry = makeLogEntry({ document: encoded })
    const manager = makeManager()

    expect(() => applyIndexEntry(entry, manager, vectorFieldPaths, vecIndexes)).toThrow(
      'Vector field "embedding" has invalid byte length 5 (must be divisible by 4)',
    )
  })
})
