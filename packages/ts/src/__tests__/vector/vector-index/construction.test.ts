import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex construction and basic operations', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

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

describe('VectorIndex insert and remove', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

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
