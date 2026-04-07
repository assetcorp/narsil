import { describe, expect, it } from 'vitest'
import {
  createScalarQuantizer,
  deserializeScalarQuantizer,
  type ScalarQuantizer,
} from '../../vector/scalar-quantization'
import { magnitude } from '../../vector/similarity'

function normalizedVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  const mag = magnitude(v)
  if (mag > 0) {
    for (let i = 0; i < dim; i++) {
      v[i] /= mag
    }
  }
  return v
}

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('ScalarQuantizer', () => {
  const DIM = 16

  describe('construction', () => {
    it('creates with correct dimensions', () => {
      const sq = createScalarQuantizer(DIM)
      expect(sq.dimensions).toBe(DIM)
    })

    it('starts uncalibrated', () => {
      const sq = createScalarQuantizer(DIM)
      expect(sq.isCalibrated()).toBe(false)
    })

    it('starts with size 0', () => {
      const sq = createScalarQuantizer(DIM)
      expect(sq.size).toBe(0)
    })
  })

  describe('calibration', () => {
    it('sets min/max from a set of vectors', () => {
      const sq = createScalarQuantizer(DIM)
      const vectors = [normalizedVector(DIM, 1), normalizedVector(DIM, 2), normalizedVector(DIM, 3)]

      sq.calibrate(vectors)
      expect(sq.isCalibrated()).toBe(true)
    })

    it('calibrating with empty iterator is a no-op', () => {
      const sq = createScalarQuantizer(DIM)
      sq.calibrate([])
      expect(sq.isCalibrated()).toBe(false)
    })

    it('handles uniform values where all components are identical', () => {
      const sq = createScalarQuantizer(4)
      const uniform = vectorFromValues(0.5, 0.5, 0.5, 0.5)
      sq.calibrate([uniform])
      expect(sq.isCalibrated()).toBe(true)

      sq.quantize('doc1', uniform)
      expect(sq.size).toBe(1)
      expect(sq.getQuantized('doc1')).toBeDefined()
    })
  })

  describe('quantize', () => {
    it('stores a quantized representation', () => {
      const sq = createScalarQuantizer(DIM)
      const v = normalizedVector(DIM, 1)
      sq.calibrate([v, normalizedVector(DIM, 2)])
      sq.quantize('doc1', v)

      const quantized = sq.getQuantized('doc1')
      expect(quantized).toBeInstanceOf(Uint8Array)
      if (quantized) {
        expect(quantized.length).toBe(DIM)
      }
    })

    it('increases size after quantize', () => {
      const sq = createScalarQuantizer(DIM)
      const vectors = [normalizedVector(DIM, 1), normalizedVector(DIM, 2)]
      sq.calibrate(vectors)

      expect(sq.size).toBe(0)
      sq.quantize('doc1', vectors[0])
      expect(sq.size).toBe(1)
      sq.quantize('doc2', vectors[1])
      expect(sq.size).toBe(2)
    })

    it('auto-calibrates when quantizing before explicit calibration', () => {
      const sq = createScalarQuantizer(DIM)
      const v = normalizedVector(DIM, 1)

      sq.quantize('doc1', v)
      expect(sq.isCalibrated()).toBe(true)
      expect(sq.size).toBe(1)
    })
  })

  describe('distance computation', () => {
    let sq: ScalarQuantizer
    const queryVec = normalizedVector(DIM, 10)
    const nearVec = normalizedVector(DIM, 10.1)
    const farVec = normalizedVector(DIM, 99)

    function setupQuantizer(): void {
      sq = createScalarQuantizer(DIM)
      const allVecs = [queryVec, nearVec, farVec, normalizedVector(DIM, 50)]
      sq.calibrate(allVecs)
      sq.quantize('near', nearVec)
      sq.quantize('far', farVec)
    }

    it('prepareQuery returns a QuantizedQuery object', () => {
      setupQuantizer()
      const prepared = sq.prepareQuery(queryVec)
      expect(prepared).not.toBeNull()
      if (prepared) {
        expect(prepared.quantized).toBeInstanceOf(Uint8Array)
        expect(prepared.quantized.length).toBe(DIM)
        expect(typeof prepared.sum).toBe('number')
        expect(typeof prepared.sumSq).toBe('number')
        expect(typeof prepared.magnitude).toBe('number')
      }
    })

    it('prepareQuery returns null when uncalibrated', () => {
      const uncalibrated = createScalarQuantizer(DIM)
      expect(uncalibrated.prepareQuery(queryVec)).toBeNull()
    })

    it('cosine metric produces scores in 0-1 range for normalized vectors', () => {
      setupQuantizer()
      const prepared = sq.prepareQuery(queryVec)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq.distanceFromPrepared(prepared, 'near', 'cosine')
      const distFar = sq.distanceFromPrepared(prepared, 'far', 'cosine')

      expect(distNear).toBeGreaterThanOrEqual(-0.1)
      expect(distNear).toBeLessThanOrEqual(2.1)
      expect(distFar).toBeGreaterThanOrEqual(-0.1)
      expect(distFar).toBeLessThanOrEqual(2.1)
    })

    it('dotProduct metric produces finite values', () => {
      setupQuantizer()
      const prepared = sq.prepareQuery(queryVec)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq.distanceFromPrepared(prepared, 'near', 'dotProduct')
      const distFar = sq.distanceFromPrepared(prepared, 'far', 'dotProduct')

      expect(Number.isFinite(distNear)).toBe(true)
      expect(Number.isFinite(distFar)).toBe(true)
    })

    it('euclidean metric produces non-negative values', () => {
      setupQuantizer()
      const prepared = sq.prepareQuery(queryVec)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq.distanceFromPrepared(prepared, 'near', 'euclidean')
      const distFar = sq.distanceFromPrepared(prepared, 'far', 'euclidean')

      expect(distNear).toBeGreaterThanOrEqual(0)
      expect(distFar).toBeGreaterThanOrEqual(0)
    })

    it('preserves distance ordering for well-separated vectors with cosine', () => {
      const sq2 = createScalarQuantizer(DIM)
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

      sq2.calibrate([query, near, far])
      sq2.quantize('near', near)
      sq2.quantize('far', far)

      const prepared = sq2.prepareQuery(query)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq2.distanceFromPrepared(prepared, 'near', 'cosine')
      const distFar = sq2.distanceFromPrepared(prepared, 'far', 'cosine')

      expect(distNear).toBeLessThan(distFar)
    })

    it('preserves distance ordering for well-separated vectors with euclidean', () => {
      const sq2 = createScalarQuantizer(DIM)
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

      sq2.calibrate([query, near, far])
      sq2.quantize('near', near)
      sq2.quantize('far', far)

      const prepared = sq2.prepareQuery(query)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq2.distanceFromPrepared(prepared, 'near', 'euclidean')
      const distFar = sq2.distanceFromPrepared(prepared, 'far', 'euclidean')

      expect(distNear).toBeLessThan(distFar)
    })

    it('preserves distance ordering for well-separated vectors with dotProduct', () => {
      const sq2 = createScalarQuantizer(DIM)
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

      sq2.calibrate([query, highDp, lowDp])
      sq2.quantize('highDp', highDp)
      sq2.quantize('lowDp', lowDp)

      const prepared = sq2.prepareQuery(query)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distHighDp = sq2.distanceFromPrepared(prepared, 'highDp', 'dotProduct')
      const distLowDp = sq2.distanceFromPrepared(prepared, 'lowDp', 'dotProduct')

      expect(distHighDp).toBeLessThan(distLowDp)
    })

    it('returns POSITIVE_INFINITY for nonexistent docId', () => {
      setupQuantizer()
      const prepared = sq.prepareQuery(queryVec)
      if (!prepared) throw new Error('prepareQuery returned null')

      expect(sq.distanceFromPrepared(prepared, 'nonexistent', 'cosine')).toBe(Number.POSITIVE_INFINITY)
    })
  })

  describe('recalibration', () => {
    it('updates min/max and re-quantizes stored vectors', () => {
      const sq = createScalarQuantizer(DIM)
      const v1 = normalizedVector(DIM, 1)
      const v2 = normalizedVector(DIM, 2)
      sq.calibrate([v1, v2])
      sq.quantize('doc1', v1)
      sq.quantize('doc2', v2)

      const wideRange = vectorFromValues(...Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 10 : -10)))
      sq.recalibrateAll([
        ['doc1', v1],
        ['doc2', v2],
        ['doc3', wideRange],
      ])

      expect(sq.size).toBe(3)
      expect(sq.isCalibrated()).toBe(true)
    })

    it('still produces correct distance ordering after recalibration', () => {
      const sq = createScalarQuantizer(DIM)
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

      sq.calibrate([query, near, far])
      sq.quantize('near', near)
      sq.quantize('far', far)

      const outlier = vectorFromValues(...Array.from({ length: DIM }, (_, i) => (i === 0 ? 5 : -5)))
      sq.recalibrateAll([
        ['near', near],
        ['far', far],
        ['outlier', outlier],
      ])

      const prepared = sq.prepareQuery(query)
      if (!prepared) throw new Error('prepareQuery returned null')

      const distNear = sq.distanceFromPrepared(prepared, 'near', 'cosine')
      const distFar = sq.distanceFromPrepared(prepared, 'far', 'cosine')
      expect(distNear).toBeLessThan(distFar)
    })
  })

  describe('needsRecalibration', () => {
    it('returns false when uncalibrated', () => {
      const sq = createScalarQuantizer(DIM)
      const v = normalizedVector(DIM, 1)
      expect(sq.needsRecalibration(v)).toBe(false)
    })

    it('returns false for vectors within calibrated bounds', () => {
      const sq = createScalarQuantizer(DIM)
      const v1 = normalizedVector(DIM, 1)
      const v2 = normalizedVector(DIM, 2)
      sq.calibrate([v1, v2])

      expect(sq.needsRecalibration(v1)).toBe(false)
    })

    it('returns true for vectors outside calibrated bounds', () => {
      const sq = createScalarQuantizer(4)
      sq.calibrate([vectorFromValues(0, 0, 0, 0), vectorFromValues(1, 1, 1, 1)])

      const outsideBounds = vectorFromValues(100, 100, 100, 100)
      expect(sq.needsRecalibration(outsideBounds)).toBe(true)
    })
  })

  describe('serialization', () => {
    it('serialize returns SerializedSQ8 with correct fields', () => {
      const sq = createScalarQuantizer(DIM)
      const v = normalizedVector(DIM, 1)
      sq.calibrate([v])
      sq.quantize('doc1', v)

      const serialized = sq.serialize()
      expect(typeof serialized.alpha).toBe('number')
      expect(typeof serialized.offset).toBe('number')
      expect(serialized.quantizedVectors).toBeDefined()
      expect(serialized.vectorSums).toBeDefined()
      expect(serialized.vectorSumSqs).toBeDefined()
      expect(serialized.quantizedVectors['doc1']).toBeDefined()
      expect(Array.isArray(serialized.quantizedVectors['doc1'])).toBe(true)
    })

    it('deserializeScalarQuantizer restores a working quantizer', () => {
      const sq = createScalarQuantizer(DIM)
      const v1 = normalizedVector(DIM, 1)
      const v2 = normalizedVector(DIM, 2)
      sq.calibrate([v1, v2])
      sq.quantize('doc1', v1)
      sq.quantize('doc2', v2)

      const serialized = sq.serialize()
      const restored = deserializeScalarQuantizer(serialized, DIM)

      expect(restored.isCalibrated()).toBe(true)
      expect(restored.size).toBe(2)
      expect(restored.dimensions).toBe(DIM)
      expect(restored.getQuantized('doc1')).toBeDefined()
      expect(restored.getQuantized('doc2')).toBeDefined()
    })

    it('round-trip preserves distance ordering', () => {
      const sq = createScalarQuantizer(DIM)
      const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

      sq.calibrate([query, near, far])
      sq.quantize('near', near)
      sq.quantize('far', far)

      const serialized = sq.serialize()
      const restored = deserializeScalarQuantizer(serialized, DIM)

      const prepared = restored.prepareQuery(query)
      if (!prepared) throw new Error('prepareQuery returned null after deserialization')

      const distNear = restored.distanceFromPrepared(prepared, 'near', 'cosine')
      const distFar = restored.distanceFromPrepared(prepared, 'far', 'cosine')
      expect(distNear).toBeLessThan(distFar)
    })

    it('deserializes empty quantizer correctly', () => {
      const sq = createScalarQuantizer(DIM)
      const serialized = sq.serialize()
      const restored = deserializeScalarQuantizer(serialized, DIM)

      expect(restored.isCalibrated()).toBe(false)
      expect(restored.size).toBe(0)
    })
  })

  describe('remove and clear', () => {
    it('remove decreases size', () => {
      const sq = createScalarQuantizer(DIM)
      const v1 = normalizedVector(DIM, 1)
      const v2 = normalizedVector(DIM, 2)
      sq.calibrate([v1, v2])
      sq.quantize('doc1', v1)
      sq.quantize('doc2', v2)

      expect(sq.size).toBe(2)
      sq.remove('doc1')
      expect(sq.size).toBe(1)
      expect(sq.getQuantized('doc1')).toBeUndefined()
      expect(sq.getQuantized('doc2')).toBeDefined()
    })

    it('clear resets to empty uncalibrated state', () => {
      const sq = createScalarQuantizer(DIM)
      const v = normalizedVector(DIM, 1)
      sq.calibrate([v])
      sq.quantize('doc1', v)

      sq.clear()
      expect(sq.size).toBe(0)
      expect(sq.isCalibrated()).toBe(false)
      expect(sq.getQuantized('doc1')).toBeUndefined()
    })

    it('remove with nonexistent docId is safe', () => {
      const sq = createScalarQuantizer(DIM)
      expect(() => sq.remove('nonexistent')).not.toThrow()
    })
  })
})
