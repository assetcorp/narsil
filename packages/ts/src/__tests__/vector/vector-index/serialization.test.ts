import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createVectorIndex, type VectorIndex, type VectorIndexPayload } from '../../../vector/vector-index'
import { bytesToVectors, decodeVectorIndexPart, vectorsToBytes } from '../../../vector/vector-index/payload'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

function partOf(
  docIds: string[],
  vectors: number[][],
  overrides: Partial<VectorIndexPayload> = {},
): VectorIndexPayload {
  const flat = new Float32Array(vectors.length * DIM)
  for (let i = 0; i < vectors.length; i++) flat.set(vectors[i], i * DIM)
  return {
    v: 2,
    fieldName: 'embedding',
    dimension: DIM,
    part: 0,
    parts: 1,
    docIds,
    graphs: [],
    codes: null,
    vectors: vectorsToBytes(flat),
    ...overrides,
  }
}

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

  it('serialize writes one versioned part with the vectors as little-endian float32 bytes', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))

    const parts = index.serialize()

    expect(parts).toHaveLength(1)
    const [part] = parts
    expect(part.v).toBe(2)
    expect(part.fieldName).toBe('embedding')
    expect(part.dimension).toBe(DIM)
    expect(part.part).toBe(0)
    expect(part.parts).toBe(1)
    expect(part.docIds).toEqual(['doc1', 'doc2'])
    expect(part.graphs).toHaveLength(0)
    expect(part.codes).toBeNull()
    expect(part.vectors.byteLength).toBe(2 * DIM * 4)
    expect(Array.from(bytesToVectors(part.vectors))).toEqual([1, 0, 0, 0, 0, 1, 0, 0])
  })

  it('serialize excludes tombstoned docs', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))
    index.remove('doc1')

    const [part] = index.serialize()

    expect(part.docIds).toEqual(['doc2'])
    expect(part.vectors.byteLength).toBe(DIM * 4)
  })

  it('serialize includes HNSW graph when built', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const [part] = index.serialize()

    expect(part.graphs).toHaveLength(1)
    expect(part.graphs[0].nodes.length).toBeGreaterThan(0)
  })

  it('serialize writes a code record per vector once the quantizer has calibrated', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq4' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      const [part] = sqIndex.serialize()
      expect(part.codes).not.toBeNull()
      expect(part.codes?.bits).toBe(4)
      expect(part.codes?.centroid).toHaveLength(DIM)
      expect(part.codes?.records.byteLength).toBe(6 * (4 * Math.ceil(DIM / 8) + 16))
    } finally {
      sqIndex.dispose()
    }
  })

  it('deserialize restores vectors', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))

    const parts = index.serialize()

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize(parts)

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
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const parts = index.serialize()

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize(parts)

    expect(restored.maintenanceStatus().graphCount).toBe(1)
    expect(restored.maintenanceStatus().bufferSize).toBe(0)

    restored.dispose()
  })

  it('deserialize restores the code records and the centroid without quantizing again', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq4' })
    for (let i = 0; i < 6; i++) {
      sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    sqIndex.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await sqIndex.awaitPendingBuild()

    const [written] = sqIndex.serialize()

    const restored = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq4' })
    restored.deserialize([written])

    const [again] = restored.serialize()
    expect(again.codes).not.toBeNull()
    expect(again.codes?.centroid).toEqual(written.codes?.centroid)
    expect(Array.from(again.codes?.records ?? [])).toEqual(Array.from(written.codes?.records ?? []))

    sqIndex.dispose()
    restored.dispose()
  })

  it('deserialize throws on dimension mismatch', () => {
    const payload = partOf([], [], { dimension: 8, vectors: new Uint8Array(0) })

    expect(() => index.deserialize([payload])).toThrow(NarsilError)
    expect(() => index.deserialize([payload])).toThrow(/dimension/)
  })

  it('the part reader rejects a vectors bin whose length disagrees with the document count', () => {
    const raw = { ...partOf(['bad'], [[1, 0, 0, 0]]), vectors: new Uint8Array(3) }

    expect(() => decodeVectorIndexPart(raw)).toThrow(NarsilError)
    expect(() => decodeVectorIndexPart(raw)).toThrow(/float32/)
  })

  it('the part reader rejects the earlier unversioned layout with ENVELOPE_VERSION_MISMATCH', () => {
    const legacy = { fieldName: 'embedding', dimension: DIM, vectors: [], graphs: [], sq8: null }

    try {
      decodeVectorIndexPart(legacy)
      throw new Error('the reader accepted an unversioned payload')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
    }
  })

  it('serialize then deserialize round-trip preserves search results', async () => {
    const vectors = new Map<string, Float32Array>()
    for (let i = 0; i < 6; i++) {
      const v = normalizedVector(DIM, i + 1)
      vectors.set(`doc${i}`, v)
      index.insert(`doc${i}`, v)
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const query = normalizedVector(DIM, 45)
    const originalResults = index.search(query, 5, { metric: 'cosine', minSimilarity: 0 })

    const parts = index.serialize()

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize(parts)

    const restoredResults = restored.search(query, 5, { metric: 'cosine', minSimilarity: 0 })

    expect(restoredResults.length).toBe(originalResults.length)
    for (let i = 0; i < originalResults.length; i++) {
      expect(restoredResults[i].docId).toBe(originalResults[i].docId)
      expect(restoredResults[i].score).toBeCloseTo(originalResults[i].score, 5)
    }

    restored.dispose()
  })

  it('deserialize with no graphs puts all docs in buffer', () => {
    const payload = partOf(
      ['a', 'b'],
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
    )

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([payload])

    expect(restored.maintenanceStatus().graphCount).toBe(0)
    expect(restored.maintenanceStatus().bufferSize).toBe(2)

    restored.dispose()
  })

  it('deserialize with graphs puts unmatched docs in buffer', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const [part] = index.serialize()
    const extra = normalizedVector(DIM, 59)
    const joined = new Float32Array(bytesToVectors(part.vectors).length + DIM)
    joined.set(bytesToVectors(part.vectors), 0)
    joined.set(extra, joined.length - DIM)
    const widened = { ...part, docIds: [...part.docIds, 'extra'], vectors: vectorsToBytes(joined) }

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([widened])

    expect(restored.has('extra')).toBe(true)
    expect(restored.maintenanceStatus().bufferSize).toBe(1)

    restored.dispose()
  })

  it('deserialize joins the sequences of several partition files into one store', () => {
    const first = partOf(['a'], [[1, 0, 0, 0]])
    const second = partOf(['b'], [[0, 1, 0, 0]])

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([first, second])

    expect(restored.size).toBe(2)
    expect(Array.from(restored.getVector('b') ?? [])).toEqual([0, 1, 0, 0])

    restored.dispose()
  })
})
