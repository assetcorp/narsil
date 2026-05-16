import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilError } from '../../../errors'
import { createVectorIndex, type VectorIndex, type VectorIndexPayload } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex serialization', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

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
