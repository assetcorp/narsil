import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createVectorIndex, type VectorIndex, type VectorIndexPayload } from '../../vector/vector-index'

vi.mock('../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

const DIM = 4

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

function normalizedVector(dim: number): Float32Array {
  const v = randomVector(dim)
  let sumSq = 0
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i]
  const mag = Math.sqrt(sumSq)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) v[i] /= mag
  return v
}

describe('VectorIndex', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  describe('construction and basic operations', () => {
    it('creates with correct dimension and fieldName', () => {
      expect(index.dimension).toBe(DIM)
      expect(index.fieldName).toBe('embedding')
    })

    it('throws on invalid dimension (0)', () => {
      expect(() => createVectorIndex('v', 0)).toThrow(NarsilError)
      expect(() => createVectorIndex('v', 0)).toThrow(/positive integer/)
    })

    it('throws on negative dimension', () => {
      expect(() => createVectorIndex('v', -3)).toThrow(NarsilError)
    })

    it('throws on non-integer dimension', () => {
      expect(() => createVectorIndex('v', 3.5)).toThrow(NarsilError)
    })

    it('starts empty with size 0', () => {
      expect(index.size).toBe(0)
    })

    it('insert adds a vector and size increases', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      expect(index.size).toBe(1)
    })

    it('insert with wrong dimension throws VECTOR_DIMENSION_MISMATCH', () => {
      try {
        index.insert('doc1', vectorFromValues(1, 0, 0))
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.VECTOR_DIMENSION_MISMATCH)
      }
    })

    it('has returns true for inserted docs, false for missing', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      expect(index.has('doc1')).toBe(true)
      expect(index.has('nonexistent')).toBe(false)
    })

    it('getVector returns a copy of the stored vector', () => {
      const original = vectorFromValues(1, 2, 3, 4)
      index.insert('doc1', original)
      const retrieved = index.getVector('doc1')
      expect(retrieved).not.toBeNull()
      expect(retrieved).toBeInstanceOf(Float32Array)
      expect(Array.from(retrieved as Float32Array)).toEqual([1, 2, 3, 4])
      expect(retrieved).not.toBe(original)
    })

    it('getVector returns null for removed docs', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.remove('doc1')
      expect(index.getVector('doc1')).toBeNull()
    })
  })

  describe('insert and remove', () => {
    it('remove marks as tombstone, size decreases, has returns false', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))
      expect(index.size).toBe(2)

      index.remove('doc1')
      expect(index.size).toBe(1)
      expect(index.has('doc1')).toBe(false)
      expect(index.has('doc2')).toBe(true)
    })

    it('remove is idempotent for non-existent doc', () => {
      expect(() => index.remove('nonexistent')).not.toThrow()
      expect(index.size).toBe(0)
    })

    it('re-insert after remove resurrects the doc', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.remove('doc1')
      expect(index.has('doc1')).toBe(false)

      index.insert('doc1', vectorFromValues(0, 1, 0, 0))
      expect(index.has('doc1')).toBe(true)
      expect(index.size).toBe(1)

      const vec = index.getVector('doc1')
      expect(vec).not.toBeNull()
      expect(Array.from(vec as Float32Array)).toEqual([0, 1, 0, 0])
    })

    it('buffer tracks inserted docs', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))

      const status = index.maintenanceStatus()
      expect(status.bufferSize).toBe(2)
    })
  })

  describe('search (brute-force only, no HNSW)', () => {
    it('search with cosine metric returns results sorted by similarity', () => {
      index.insert('near', vectorFromValues(0.9, 0.1, 0, 0))
      index.insert('far', vectorFromValues(0, 0, 0, 1))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results.length).toBe(2)
      expect(results[0].docId).toBe('near')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('search with dotProduct metric works', () => {
      index.insert('high', vectorFromValues(10, 0, 0, 0))
      index.insert('low', vectorFromValues(0, 10, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
        metric: 'dotProduct',
        minSimilarity: -Infinity,
      })

      expect(results.length).toBe(2)
      expect(results[0].docId).toBe('high')
    })

    it('search with euclidean metric works', () => {
      index.insert('close', vectorFromValues(1.1, 0.1, 0, 0))
      index.insert('distant', vectorFromValues(5, 5, 5, 5))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 2, {
        metric: 'euclidean',
        minSimilarity: 0,
      })

      expect(results.length).toBe(2)
      expect(results[0].docId).toBe('close')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('search with k=0 returns empty', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 0, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results).toHaveLength(0)
    })

    it('search with empty index returns empty', () => {
      const results = index.search(vectorFromValues(1, 0, 0, 0), 5, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results).toHaveLength(0)
    })

    it('search with minSimilarity filters low-scoring results', () => {
      index.insert('aligned', vectorFromValues(0.95, 0.05, 0, 0))
      index.insert('orthogonal', vectorFromValues(0, 1, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
        metric: 'cosine',
        minSimilarity: 0.9,
      })

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9)
      }
      expect(results.some(r => r.docId === 'orthogonal')).toBe(false)
    })

    it('search with filterDocIds restricts candidates', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))
      index.insert('doc3', vectorFromValues(0, 0, 1, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
        metric: 'cosine',
        minSimilarity: 0,
        filterDocIds: new Set(['doc1', 'doc3']),
      })

      const docIds = results.map(r => r.docId)
      expect(docIds).toContain('doc1')
      expect(docIds).not.toContain('doc2')
    })

    it('search with empty filterDocIds returns empty', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))

      const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
        metric: 'cosine',
        minSimilarity: 0,
        filterDocIds: new Set<string>(),
      })

      expect(results).toHaveLength(0)
    })

    it('search excludes tombstoned documents', () => {
      index.insert('keep', vectorFromValues(0.9, 0.1, 0, 0))
      index.insert('removed', vectorFromValues(0.95, 0.05, 0, 0))
      index.remove('removed')

      const results = index.search(vectorFromValues(1, 0, 0, 0), 10, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results.every(r => r.docId !== 'removed')).toBe(true)
      expect(results.some(r => r.docId === 'keep')).toBe(true)
    })
  })

  describe('search with HNSW (after build)', () => {
    async function insertAndBuild(idx: VectorIndex, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        idx.insert(`doc${i}`, normalizedVector(DIM))
      }
      idx.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await idx.awaitPendingBuild()
    }

    it('after enough inserts to exceed promotionThreshold, scheduleBuild triggers a build', async () => {
      const statusBefore = index.maintenanceStatus()
      expect(statusBefore.graphCount).toBe(0)

      await insertAndBuild(index, 6)

      const statusAfter = index.maintenanceStatus()
      expect(statusAfter.graphCount).toBe(1)
    })

    it('after build completes, search uses HNSW and returns results', async () => {
      await insertAndBuild(index, 10)

      const results = index.search(normalizedVector(DIM), 5, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('buffer candidates searched alongside HNSW results', async () => {
      await insertAndBuild(index, 6)

      const target = vectorFromValues(1, 0, 0, 0)
      index.insert('buffer-doc', vectorFromValues(0.99, 0.01, 0, 0))

      const results = index.search(target, 10, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      expect(results.some(r => r.docId === 'buffer-doc')).toBe(true)
    })

    it('mergeResults deduplicates between HNSW and buffer results', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      index.insert('doc0', normalizedVector(DIM))

      const results = index.search(normalizedVector(DIM), 10, {
        metric: 'cosine',
        minSimilarity: 0,
      })

      const docIds = results.map(r => r.docId)
      const uniqueDocIds = new Set(docIds)
      expect(uniqueDocIds.size).toBe(docIds.length)
    })

    it('filtered search with low selectivity falls through to brute-force', async () => {
      const filteredIndex = createVectorIndex('vec', DIM, {
        threshold: 5,
        filterThreshold: 0.5,
        quantization: 'none',
      })
      try {
        await insertAndBuild(filteredIndex, 10)

        const filterIds = new Set(['doc0'])
        const results = filteredIndex.search(normalizedVector(DIM), 5, {
          metric: 'cosine',
          minSimilarity: 0,
          filterDocIds: filterIds,
        })

        expect(results.length).toBeLessThanOrEqual(1)
        if (results.length > 0) {
          expect(results[0].docId).toBe('doc0')
        }
      } finally {
        filteredIndex.dispose()
      }
    })

    it('efSearch parameter is forwarded to HNSW', async () => {
      await insertAndBuild(index, 10)

      const results = index.search(normalizedVector(DIM), 3, {
        metric: 'cosine',
        minSimilarity: 0,
        efSearch: 50,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)
    })
  })

  describe('build scheduling', () => {
    it('scheduleBuild does nothing when below threshold', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.scheduleBuild()

      const status = index.maintenanceStatus()
      expect(status.graphCount).toBe(0)
      expect(status.building).toBe(false)
    })

    it('scheduleBuild does nothing when already building', async () => {
      const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
      try {
        for (let i = 0; i < 150; i++) {
          buildIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        buildIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()

        const status = buildIndex.maintenanceStatus()
        expect(status.building).toBe(true)

        buildIndex.scheduleBuild()

        while (buildIndex.maintenanceStatus().building) {
          await vi.advanceTimersToNextTimerAsync()
        }
        await buildIndex.awaitPendingBuild()

        expect(buildIndex.maintenanceStatus().graphCount).toBe(1)
      } finally {
        buildIndex.dispose()
      }
    })

    it('scheduleBuild does nothing when disposed', () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.dispose()
      index.scheduleBuild()

      const status = index.maintenanceStatus()
      expect(status.graphCount).toBe(0)
    })

    it('triggerBuild creates HNSW from live docs excluding tombstones', async () => {
      for (let i = 0; i < 8; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.remove('doc0')
      index.remove('doc1')

      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      expect(index.maintenanceStatus().graphCount).toBe(1)

      const results = index.search(normalizedVector(DIM), 10, {
        metric: 'cosine',
        minSimilarity: 0,
      })
      const docIds = results.map(r => r.docId)
      expect(docIds).not.toContain('doc0')
      expect(docIds).not.toContain('doc1')
    })

    it('awaitPendingBuild waits for build to complete', async () => {
      const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
      try {
        for (let i = 0; i < 150; i++) {
          buildIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        buildIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()

        expect(buildIndex.maintenanceStatus().building).toBe(true)

        const awaitPromise = buildIndex.awaitPendingBuild()
        while (buildIndex.maintenanceStatus().building) {
          await vi.advanceTimersToNextTimerAsync()
        }
        await awaitPromise

        expect(buildIndex.maintenanceStatus().building).toBe(false)
        expect(buildIndex.maintenanceStatus().graphCount).toBe(1)
      } finally {
        buildIndex.dispose()
      }
    })

    it('awaitPendingBuild returns immediately when no build pending', async () => {
      await index.awaitPendingBuild()
      expect(index.maintenanceStatus().building).toBe(false)
    })
  })

  describe('dispose', () => {
    it('dispose prevents new builds', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.dispose()
      index.scheduleBuild()

      await vi.advanceTimersToNextTimerAsync()
      expect(index.maintenanceStatus().graphCount).toBe(0)
    })

    it('dispose during build does not produce an HNSW graph', async () => {
      const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
      for (let i = 0; i < 150; i++) {
        buildIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      buildIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()

      expect(buildIndex.maintenanceStatus().building).toBe(true)

      buildIndex.dispose()

      while (buildIndex.maintenanceStatus().building) {
        await vi.advanceTimersToNextTimerAsync()
      }
      await buildIndex.awaitPendingBuild()

      expect(buildIndex.maintenanceStatus().graphCount).toBe(0)
    })
  })

  describe('compact', () => {
    it('compact removes tombstoned docs from store', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))
      index.remove('doc1')

      expect(index.maintenanceStatus().tombstoneRatio).toBeGreaterThan(0)

      index.compact()

      expect(index.maintenanceStatus().tombstoneRatio).toBe(0)
      expect(index.has('doc1')).toBe(false)
      expect(index.has('doc2')).toBe(true)
      expect(index.size).toBe(1)
    })

    it('compact recalibrates SQ8 when calibrated', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      try {
        for (let i = 0; i < 6; i++) {
          sqIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        sqIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()
        await sqIndex.awaitPendingBuild()

        sqIndex.remove('doc0')
        sqIndex.remove('doc1')
        sqIndex.compact()

        expect(sqIndex.maintenanceStatus().tombstoneRatio).toBe(0)
        expect(sqIndex.size).toBe(4)
      } finally {
        sqIndex.dispose()
      }
    })

    it('compact is a no-op when no tombstones', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      const sizeBefore = index.size
      index.compact()
      expect(index.size).toBe(sizeBefore)
    })
  })

  describe('optimize', () => {
    it('optimize compacts then rebuilds HNSW', async () => {
      for (let i = 0; i < 8; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.remove('doc0')

      await index.optimize()

      expect(index.maintenanceStatus().graphCount).toBe(1)
      expect(index.maintenanceStatus().tombstoneRatio).toBe(0)
      expect(index.maintenanceStatus().bufferSize).toBe(0)
    })

    it('optimize with empty index clears HNSW and buffer', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      for (let i = 0; i < 6; i++) {
        index.remove(`doc${i}`)
      }

      await index.optimize()

      expect(index.maintenanceStatus().graphCount).toBe(0)
      expect(index.maintenanceStatus().bufferSize).toBe(0)
      expect(index.size).toBe(0)
    })

    it('optimize recalibrates SQ8', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      try {
        for (let i = 0; i < 6; i++) {
          sqIndex.insert(`doc${i}`, normalizedVector(DIM))
        }

        await sqIndex.optimize()

        expect(sqIndex.maintenanceStatus().graphCount).toBe(1)
        expect(sqIndex.maintenanceStatus().bufferSize).toBe(0)
      } finally {
        sqIndex.dispose()
      }
    })
  })

  describe('serialization', () => {
    it('serialize returns correct payload structure', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))

      const payload = index.serialize()

      expect(payload.fieldName).toBe('embedding')
      expect(payload.dimension).toBe(DIM)
      expect(payload.vectors).toHaveLength(2)
      expect(payload.graphs).toHaveLength(0)
      expect(payload.sq8).toBeNull()
    })

    it('serialize excludes tombstoned docs', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))
      index.remove('doc1')

      const payload = index.serialize()

      expect(payload.vectors).toHaveLength(1)
      expect(payload.vectors[0].docId).toBe('doc2')
    })

    it('serialize includes HNSW graph when built', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const payload = index.serialize()

      expect(payload.graphs).toHaveLength(1)
      expect(payload.graphs[0].nodes.length).toBeGreaterThan(0)
    })

    it('serialize includes SQ8 data when calibrated', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      try {
        for (let i = 0; i < 6; i++) {
          sqIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        sqIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()
        await sqIndex.awaitPendingBuild()

        const payload = sqIndex.serialize()
        expect(payload.sq8).not.toBeNull()
        expect(payload.sq8?.alpha).toBeDefined()
        expect(payload.sq8?.offset).toBeDefined()
      } finally {
        sqIndex.dispose()
      }
    })

    it('deserialize restores vectors', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))

      const payload = index.serialize()

      const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
      restored.deserialize(payload)

      expect(restored.size).toBe(2)
      expect(restored.has('doc1')).toBe(true)
      expect(restored.has('doc2')).toBe(true)

      const v1 = restored.getVector('doc1')
      expect(v1).not.toBeNull()
      expect(Array.from(v1 as Float32Array)).toEqual([1, 0, 0, 0])

      restored.dispose()
    })

    it('deserialize restores HNSW graph', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const payload = index.serialize()

      const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
      restored.deserialize(payload)

      expect(restored.maintenanceStatus().graphCount).toBe(1)
      expect(restored.maintenanceStatus().bufferSize).toBe(0)

      restored.dispose()
    })

    it('deserialize restores SQ8 data', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      const payload = sqIndex.serialize()

      const restored = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      restored.deserialize(payload)

      const restoredPayload = restored.serialize()
      expect(restoredPayload.sq8).not.toBeNull()

      sqIndex.dispose()
      restored.dispose()
    })

    it('deserialize throws on dimension mismatch', () => {
      const payload: VectorIndexPayload = {
        fieldName: 'embedding',
        dimension: 8,
        vectors: [],
        graphs: [],
        sq8: null,
      }

      expect(() => index.deserialize(payload)).toThrow(NarsilError)
      expect(() => index.deserialize(payload)).toThrow(/dimension/)
    })

    it('deserialize throws on vector dimension mismatch', () => {
      const payload: VectorIndexPayload = {
        fieldName: 'embedding',
        dimension: DIM,
        vectors: [{ docId: 'bad', vector: [1, 2, 3, 4, 5, 6, 7, 8] }],
        graphs: [],
        sq8: null,
      }

      expect(() => index.deserialize(payload)).toThrow(NarsilError)
      expect(() => index.deserialize(payload)).toThrow(/dimension/)
    })

    it('serialize then deserialize round-trip preserves search results', async () => {
      const vectors = new Map<string, Float32Array>()
      for (let i = 0; i < 6; i++) {
        const v = normalizedVector(DIM)
        vectors.set(`doc${i}`, v)
        index.insert(`doc${i}`, v)
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const query = normalizedVector(DIM)
      const originalResults = index.search(query, 5, { metric: 'cosine', minSimilarity: 0 })

      const payload = index.serialize()

      const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
      restored.deserialize(payload)

      const restoredResults = restored.search(query, 5, { metric: 'cosine', minSimilarity: 0 })

      expect(restoredResults.length).toBe(originalResults.length)
      for (let i = 0; i < originalResults.length; i++) {
        expect(restoredResults[i].docId).toBe(originalResults[i].docId)
        expect(restoredResults[i].score).toBeCloseTo(originalResults[i].score, 5)
      }

      restored.dispose()
    })

    it('deserialize with no graphs puts all docs in buffer', () => {
      const payload: VectorIndexPayload = {
        fieldName: 'embedding',
        dimension: DIM,
        vectors: [
          { docId: 'a', vector: [1, 0, 0, 0] },
          { docId: 'b', vector: [0, 1, 0, 0] },
        ],
        graphs: [],
        sq8: null,
      }

      const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
      restored.deserialize(payload)

      expect(restored.maintenanceStatus().graphCount).toBe(0)
      expect(restored.maintenanceStatus().bufferSize).toBe(2)

      restored.dispose()
    })

    it('deserialize with graphs puts unmatched docs in buffer', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const payload = index.serialize()

      payload.vectors.push({ docId: 'extra', vector: Array.from(normalizedVector(DIM)) })

      const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
      restored.deserialize(payload)

      expect(restored.has('extra')).toBe(true)
      expect(restored.maintenanceStatus().bufferSize).toBe(1)

      restored.dispose()
    })
  })

  describe('maintenance status', () => {
    it('reports correct tombstoneRatio', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))
      index.remove('doc1')

      const status = index.maintenanceStatus()
      expect(status.tombstoneRatio).toBeCloseTo(0.5, 5)
    })

    it('reports correct bufferSize', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      index.insert('doc2', vectorFromValues(0, 1, 0, 0))

      expect(index.maintenanceStatus().bufferSize).toBe(2)
    })

    it('reports building=true during build', async () => {
      const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
      try {
        for (let i = 0; i < 150; i++) {
          buildIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        buildIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()

        expect(buildIndex.maintenanceStatus().building).toBe(true)

        while (buildIndex.maintenanceStatus().building) {
          await vi.advanceTimersToNextTimerAsync()
        }
        await buildIndex.awaitPendingBuild()

        expect(buildIndex.maintenanceStatus().building).toBe(false)
      } finally {
        buildIndex.dispose()
      }
    })

    it('reports graphCount=0 before build, 1 after', async () => {
      expect(index.maintenanceStatus().graphCount).toBe(0)

      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      expect(index.maintenanceStatus().graphCount).toBe(1)
    })
  })

  describe('memory estimation', () => {
    it('returns 0 for empty index', () => {
      expect(index.estimateMemoryBytes()).toBe(0)
    })

    it('returns non-zero for populated index', () => {
      index.insert('doc1', vectorFromValues(1, 0, 0, 0))
      expect(index.estimateMemoryBytes()).toBeGreaterThan(0)
    })

    it('increases with HNSW present', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }

      const memBefore = index.estimateMemoryBytes()

      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const memAfter = index.estimateMemoryBytes()
      expect(memAfter).toBeGreaterThan(memBefore)
    })

    it('includes SQ8 overhead when calibrated', async () => {
      const noSqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })

      try {
        for (let i = 0; i < 6; i++) {
          const v = normalizedVector(DIM)
          noSqIndex.insert(`doc${i}`, v)
          sqIndex.insert(`doc${i}`, new Float32Array(v))
        }

        noSqIndex.scheduleBuild()
        sqIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()
        await noSqIndex.awaitPendingBuild()
        await sqIndex.awaitPendingBuild()

        expect(sqIndex.estimateMemoryBytes()).toBeGreaterThan(noSqIndex.estimateMemoryBytes())
      } finally {
        noSqIndex.dispose()
        sqIndex.dispose()
      }
    })
  })

  describe('scalar quantization integration', () => {
    it('with quantization sq8, calibration happens during build', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      try {
        for (let i = 0; i < 6; i++) {
          sqIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        sqIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()
        await sqIndex.awaitPendingBuild()

        const payload = sqIndex.serialize()
        expect(payload.sq8).not.toBeNull()
      } finally {
        sqIndex.dispose()
      }
    })

    it('with quantization none, no SQ8 is created', async () => {
      for (let i = 0; i < 6; i++) {
        index.insert(`doc${i}`, normalizedVector(DIM))
      }
      index.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await index.awaitPendingBuild()

      const payload = index.serialize()
      expect(payload.sq8).toBeNull()
    })

    it('SQ8 data included in serialization when calibrated', async () => {
      const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
      try {
        for (let i = 0; i < 6; i++) {
          sqIndex.insert(`doc${i}`, normalizedVector(DIM))
        }
        sqIndex.scheduleBuild()
        await vi.advanceTimersToNextTimerAsync()
        await sqIndex.awaitPendingBuild()

        const payload = sqIndex.serialize()
        expect(payload.sq8).not.toBeNull()
        expect(typeof payload.sq8?.alpha).toBe('number')
        expect(typeof payload.sq8?.offset).toBe('number')
        expect(Object.keys(payload.sq8?.quantizedVectors ?? {}).length).toBe(6)
      } finally {
        sqIndex.dispose()
      }
    })
  })
})
