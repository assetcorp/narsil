import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  cosineSimilarityWithMagnitudes,
  dotProduct,
  euclideanDistance,
  magnitude,
  squaredEuclideanDistance,
} from '../../vector/similarity'

describe('magnitude', () => {
  it('returns 0 for a zero vector', () => {
    expect(magnitude(new Float32Array([0, 0, 0]))).toBe(0)
  })

  it('returns 1 for a unit vector along one axis', () => {
    expect(magnitude(new Float32Array([1, 0, 0]))).toBe(1)
    expect(magnitude(new Float32Array([0, 1, 0]))).toBe(1)
  })

  it('computes the magnitude of [3, 4] as 5', () => {
    expect(magnitude(new Float32Array([3, 4]))).toBeCloseTo(5, 5)
  })

  it('computes the magnitude of [1, 1, 1]', () => {
    expect(magnitude(new Float32Array([1, 1, 1]))).toBeCloseTo(Math.sqrt(3), 5)
  })

  it('handles single-element vectors', () => {
    expect(magnitude(new Float32Array([7]))).toBeCloseTo(7, 5)
    expect(magnitude(new Float32Array([-3]))).toBeCloseTo(3, 5)
  })
})

describe('dotProduct', () => {
  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    expect(dotProduct(a, b)).toBe(0)
  })

  it('computes the product of parallel vectors', () => {
    const a = new Float32Array([2, 3])
    const b = new Float32Array([4, 5])
    expect(dotProduct(a, b)).toBeCloseTo(23, 4)
  })

  it('returns the squared magnitude when dotting a vector with itself', () => {
    const v = new Float32Array([3, 4, 5])
    expect(dotProduct(v, v)).toBeCloseTo(50, 4)
  })

  it('is commutative', () => {
    const a = new Float32Array([1.5, -2.3, 4.1])
    const b = new Float32Array([-0.7, 3.2, 1.8])
    expect(dotProduct(a, b)).toBeCloseTo(dotProduct(b, a), 4)
  })

  it('handles negative values', () => {
    const a = new Float32Array([-1, -2, -3])
    const b = new Float32Array([1, 2, 3])
    expect(dotProduct(a, b)).toBeCloseTo(-14, 4)
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5)
  })

  it('returns 1 for parallel vectors with different magnitudes', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([2, 4, 6])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
  })

  it('returns -1 for antiparallel vectors', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([-1, -2, -3])
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })

  it('returns 0 when either vector is zero', () => {
    const zero = new Float32Array([0, 0, 0])
    const v = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(zero, v)).toBe(0)
    expect(cosineSimilarity(v, zero)).toBe(0)
    expect(cosineSimilarity(zero, zero)).toBe(0)
  })

  it('is commutative', () => {
    const a = new Float32Array([1.5, -2.3, 4.1])
    const b = new Float32Array([-0.7, 3.2, 1.8])
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 5)
  })
})

describe('cosineSimilarityWithMagnitudes', () => {
  it('produces the same result as cosineSimilarity when given correct magnitudes', () => {
    const a = new Float32Array([1.5, -2.3, 4.1])
    const b = new Float32Array([-0.7, 3.2, 1.8])
    const magA = magnitude(a)
    const magB = magnitude(b)

    expect(cosineSimilarityWithMagnitudes(a, b, magA, magB)).toBeCloseTo(cosineSimilarity(a, b), 5)
  })

  it('returns 0 when either magnitude is zero', () => {
    const a = new Float32Array([1, 2])
    const b = new Float32Array([3, 4])
    expect(cosineSimilarityWithMagnitudes(a, b, 0, magnitude(b))).toBe(0)
    expect(cosineSimilarityWithMagnitudes(a, b, magnitude(a), 0)).toBe(0)
  })
})

describe('euclideanDistance', () => {
  it('returns 0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    expect(euclideanDistance(v, v)).toBe(0)
  })

  it('computes the distance of a 3-4-5 triangle', () => {
    const a = new Float32Array([0, 0])
    const b = new Float32Array([3, 4])
    expect(euclideanDistance(a, b)).toBeCloseTo(5, 5)
  })

  it('is commutative', () => {
    const a = new Float32Array([1.5, -2.3, 4.1])
    const b = new Float32Array([-0.7, 3.2, 1.8])
    expect(euclideanDistance(a, b)).toBeCloseTo(euclideanDistance(b, a), 5)
  })

  it('satisfies the triangle inequality', () => {
    const a = new Float32Array([0, 0])
    const b = new Float32Array([1, 0])
    const c = new Float32Array([0, 1])
    const ab = euclideanDistance(a, b)
    const bc = euclideanDistance(b, c)
    const ac = euclideanDistance(a, c)
    expect(ab + bc).toBeGreaterThanOrEqual(ac - 1e-6)
  })

  it('handles higher dimensional vectors', () => {
    const a = new Float32Array([1, 0, 0, 0, 0])
    const b = new Float32Array([0, 0, 0, 0, 1])
    expect(euclideanDistance(a, b)).toBeCloseTo(Math.sqrt(2), 5)
  })
})

describe('squaredEuclideanDistance', () => {
  it('returns the square of euclidean distance', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([4, 5, 6])
    const dist = euclideanDistance(a, b)
    expect(squaredEuclideanDistance(a, b)).toBeCloseTo(dist * dist, 4)
  })

  it('preserves ordering compared to euclidean distance', () => {
    const origin = new Float32Array([0, 0])
    const close = new Float32Array([1, 1])
    const far = new Float32Array([3, 4])

    const sqClose = squaredEuclideanDistance(origin, close)
    const sqFar = squaredEuclideanDistance(origin, far)
    const dClose = euclideanDistance(origin, close)
    const dFar = euclideanDistance(origin, far)

    expect(sqClose < sqFar).toBe(dClose < dFar)
  })
})
