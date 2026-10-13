import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createVectorIndex, type VectorIndex, type VectorIndexPayload } from '../../../vector/vector-index'
import { bytesToVectors, decodeVectorIndexPart, vectorsToBytes } from '../../../vector/vector-index/payload'
import { fieldView } from './field-view'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

function partOf(
  docIds: string[],
  vectors: number[][],
  overrides: Partial<VectorIndexPayload> = {},
): VectorIndexPayload {
  const flat = new Float32Array(vectors.length * DIM)
  for (let i = 0; i < vectors.length; i++) flat.set(vectors[i], i * DIM)
  return {
    v: 3,
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

function earlierPayloadOf(index: VectorIndex): VectorIndexPayload {
  const view = fieldView(index)
  return {
    v: 3,
    fieldName: 'embedding',
    dimension: DIM,
    part: 0,
    parts: 1,
    docIds: view.docIds,
    graphs: view.graphs,
    codes: view.codes,
    vectors: view.vectors,
  }
}

describe('reading the vector field of an earlier snapshot', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('reads a graph that holds no node as no graph', () => {
    const headerOnly = {
      entryPoint: null,
      maxLayer: 0,
      m: 16,
      efConstruction: 200,
      metric: 'cosine' as const,
      nodes: [],
    }
    index.deserialize([partOf([], [], { graphs: [headerOnly] })])
    index.insert('doc7', normalizedVector(DIM, 8))
    expect(index.maintenanceStatus().graphCount).toBe(0)
  })

  it('restores the vectors', () => {
    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([
      partOf(
        ['doc1', 'doc2'],
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      ),
    ])

    expect(restored.size).toBe(2)
    expect(restored.has('doc1')).toBe(true)
    expect(restored.has('doc2')).toBe(true)
    expect(Array.from(restored.getVector('doc1') ?? [])).toEqual([1, 0, 0, 0])

    restored.dispose()
  })

  it('restores the graph', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([earlierPayloadOf(index)])

    expect(restored.maintenanceStatus().graphCount).toBe(1)
    expect(restored.maintenanceStatus().bufferSize).toBe(0)

    restored.dispose()
  })

  it('restores the code records and the centroid without quantizing again', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq4' })
    for (let i = 0; i < 6; i++) {
      sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    sqIndex.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await sqIndex.awaitPendingBuild()

    const written = fieldView(sqIndex)
    expect(written.codes?.records.byteLength).toBe(6 * (Math.ceil((DIM * 4) / 8) + 16))

    const restored = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq4' })
    restored.deserialize([
      {
        v: 3,
        fieldName: 'vec',
        dimension: DIM,
        part: 0,
        parts: 1,
        docIds: written.docIds,
        graphs: written.graphs,
        codes: written.codes,
        vectors: written.vectors,
      },
    ])

    const again = fieldView(restored)
    expect(again.codes).not.toBeNull()
    expect(again.codes?.centroid).toEqual(written.codes?.centroid)
    expect(Array.from(again.codes?.records ?? [])).toEqual(Array.from(written.codes?.records ?? []))

    sqIndex.dispose()
    restored.dispose()
  })

  it('throws on a dimension mismatch', () => {
    const payload = partOf([], [], { dimension: 8, vectors: new Uint8Array(0) })

    expect(() => index.deserialize([payload])).toThrow(NarsilError)
    expect(() => index.deserialize([payload])).toThrow(/dimension/)
  })

  it('rejects a vectors bin whose length disagrees with the document count', () => {
    const raw = { ...partOf(['bad'], [[1, 0, 0, 0]]), vectors: new Uint8Array(3) }

    expect(() => decodeVectorIndexPart(raw)).toThrow(NarsilError)
    expect(() => decodeVectorIndexPart(raw)).toThrow(/float32/)
  })

  it('rejects the unversioned layout before it with ENVELOPE_VERSION_MISMATCH', () => {
    const legacy = { fieldName: 'embedding', dimension: DIM, vectors: [], graphs: [], sq8: null }

    try {
      decodeVectorIndexPart(legacy)
      throw new Error('the reader accepted an unversioned payload')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
    }
  })

  it('answers the same searches after a read', async () => {
    for (let i = 0; i < 6; i++) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const query = normalizedVector(DIM, 45)
    const originalResults = index.search(query, 5, { metric: 'cosine', minSimilarity: 0 }).results

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([earlierPayloadOf(index)])

    const restoredResults = restored.search(query, 5, { metric: 'cosine', minSimilarity: 0 }).results
    expect(restoredResults.length).toBe(originalResults.length)
    for (let i = 0; i < originalResults.length; i++) {
      expect(restoredResults[i].docId).toBe(originalResults[i].docId)
      expect(restoredResults[i].score).toBeCloseTo(originalResults[i].score, 5)
    }

    restored.dispose()
  })

  it('puts every vector in the buffer when the payload holds no graph', () => {
    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([
      partOf(
        ['a', 'b'],
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      ),
    ])

    expect(restored.maintenanceStatus().graphCount).toBe(0)
    expect(restored.maintenanceStatus().bufferSize).toBe(2)

    restored.dispose()
  })

  it('puts a vector the graph leaves out in the buffer', async () => {
    for (let i = 0; i < 6; i++) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const part = earlierPayloadOf(index)
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

  it('joins the sequences of several partition files into one store', () => {
    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
    restored.deserialize([partOf(['a'], [[1, 0, 0, 0]]), partOf(['b'], [[0, 1, 0, 0]])])

    expect(restored.size).toBe(2)
    expect(Array.from(restored.getVector('b') ?? [])).toEqual([0, 1, 0, 0])

    restored.dispose()
  })

  it('leaves a removed vector out of what a checkpoint writes', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))
    index.remove('doc1')

    const view = fieldView(index)

    expect(view.docIds).toEqual(['doc2'])
    expect(Array.from(bytesToVectors(view.vectors))).toEqual([0, 1, 0, 0])
  })
})
