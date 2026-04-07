import { describe, expect, it } from 'vitest'
import {
  isSimdAvailable,
  simdDotProduct,
  simdEuclideanDistance,
  simdMagnitude,
  simdSquaredEuclideanDistance,
} from '../../vector/simd'

describe('isSimdAvailable', () => {
  it('returns true in Node.js 22 where WebAssembly SIMD is supported', () => {
    expect(isSimdAvailable()).toBe(true)
  })
})

describe('simdMagnitude', () => {
  it('returns the correct magnitude for a [3, 4] vector', () => {
    const v = new Float32Array([3, 4])
    const result = simdMagnitude(v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(5, 4)
  })

  it('returns 0 for a zero vector', () => {
    const v = new Float32Array([0, 0, 0])
    const result = simdMagnitude(v)
    expect(result).not.toBeNull()
    expect(result).toBe(0)
  })

  it('returns the correct magnitude for a unit vector', () => {
    const v = new Float32Array([1, 0, 0])
    const result = simdMagnitude(v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(1, 4)
  })

  it('computes sqrt(3) for [1, 1, 1]', () => {
    const v = new Float32Array([1, 1, 1])
    const result = simdMagnitude(v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(Math.sqrt(3), 4)
  })

  it('handles a single-element vector', () => {
    const v = new Float32Array([7])
    const result = simdMagnitude(v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(7, 4)
  })
})

describe('simdDotProduct', () => {
  it('returns the correct product for known vectors', () => {
    const a = new Float32Array([2, 3])
    const b = new Float32Array([4, 5])
    const result = simdDotProduct(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(23, 4)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    const result = simdDotProduct(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(0, 4)
  })

  it('returns the squared magnitude when dotting a vector with itself', () => {
    const v = new Float32Array([3, 4, 5])
    const result = simdDotProduct(v, v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(50, 4)
  })

  it('handles negative values', () => {
    const a = new Float32Array([-1, -2, -3])
    const b = new Float32Array([1, 2, 3])
    const result = simdDotProduct(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(-14, 4)
  })

  it('handles a single-element vector', () => {
    const a = new Float32Array([5])
    const b = new Float32Array([3])
    const result = simdDotProduct(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(15, 4)
  })
})

describe('simdEuclideanDistance', () => {
  it('returns 5 for a 3-4-5 triangle', () => {
    const a = new Float32Array([0, 0])
    const b = new Float32Array([3, 4])
    const result = simdEuclideanDistance(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(5, 4)
  })

  it('returns 0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    const result = simdEuclideanDistance(v, v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(0, 4)
  })

  it('handles higher-dimensional vectors', () => {
    const a = new Float32Array([1, 0, 0, 0, 0])
    const b = new Float32Array([0, 0, 0, 0, 1])
    const result = simdEuclideanDistance(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(Math.sqrt(2), 4)
  })

  it('handles a single-element vector', () => {
    const a = new Float32Array([10])
    const b = new Float32Array([3])
    const result = simdEuclideanDistance(a, b)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(7, 4)
  })
})

describe('simdSquaredEuclideanDistance', () => {
  it('returns the square of euclidean distance', () => {
    const a = new Float32Array([0, 0])
    const b = new Float32Array([3, 4])
    const squared = simdSquaredEuclideanDistance(a, b)
    const dist = simdEuclideanDistance(a, b)
    expect(squared).not.toBeNull()
    expect(dist).not.toBeNull()
    if (squared === null || dist === null) return
    expect(squared).toBeCloseTo(dist * dist, 3)
  })

  it('returns 0 for identical vectors', () => {
    const v = new Float32Array([5, 6, 7])
    const result = simdSquaredEuclideanDistance(v, v)
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(0, 4)
  })
})

describe('SIMD results match pure JS implementations', () => {
  function jsMagnitude(v: Float32Array): number {
    let sum = 0
    for (let i = 0; i < v.length; i++) {
      sum += v[i] * v[i]
    }
    return Math.sqrt(sum)
  }

  function jsDotProduct(a: Float32Array, b: Float32Array): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i]
    }
    return sum
  }

  function jsEuclideanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i]
      sum += diff * diff
    }
    return Math.sqrt(sum)
  }

  function jsSquaredEuclideanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i]
      sum += diff * diff
    }
    return sum
  }

  const testVectors = [
    { a: new Float32Array([1.5, -2.3, 4.1, 0.7, -1.2]), b: new Float32Array([-0.7, 3.2, 1.8, -2.5, 0.9]) },
    { a: new Float32Array([100, 200, 300]), b: new Float32Array([400, 500, 600]) },
    { a: new Float32Array([0.001, 0.002, 0.003]), b: new Float32Array([0.004, 0.005, 0.006]) },
  ]

  for (const { a, b } of testVectors) {
    const label = `[${a[0]}, ${a[1]}, ...] vs [${b[0]}, ${b[1]}, ...]`

    it(`magnitude matches JS for ${label}`, () => {
      const simd = simdMagnitude(a)
      expect(simd).not.toBeNull()
      if (simd === null) return
      expect(simd).toBeCloseTo(jsMagnitude(a), 2)
    })

    it(`dotProduct matches JS for ${label}`, () => {
      const simd = simdDotProduct(a, b)
      expect(simd).not.toBeNull()
      if (simd === null) return
      expect(simd).toBeCloseTo(jsDotProduct(a, b), 1)
    })

    it(`euclideanDistance matches JS for ${label}`, () => {
      const simd = simdEuclideanDistance(a, b)
      expect(simd).not.toBeNull()
      if (simd === null) return
      expect(simd).toBeCloseTo(jsEuclideanDistance(a, b), 1)
    })

    it(`squaredEuclideanDistance matches JS for ${label}`, () => {
      const simd = simdSquaredEuclideanDistance(a, b)
      expect(simd).not.toBeNull()
      if (simd === null) return
      expect(simd).toBeCloseTo(jsSquaredEuclideanDistance(a, b), 0)
    })
  }
})

describe('large vectors triggering WASM memory growth', () => {
  it('handles 4096-dimensional vectors that exceed initial 256KB memory', () => {
    const dim = 4096
    const a = new Float32Array(dim)
    const b = new Float32Array(dim)
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i * 0.01)
      b[i] = Math.cos(i * 0.01)
    }

    const dot = simdDotProduct(a, b)
    expect(dot).not.toBeNull()
    if (dot === null) return
    expect(typeof dot).toBe('number')
    expect(Number.isFinite(dot)).toBe(true)

    const mag = simdMagnitude(a)
    expect(mag).not.toBeNull()
    if (mag === null) return
    expect(mag).toBeGreaterThan(0)

    const dist = simdEuclideanDistance(a, b)
    expect(dist).not.toBeNull()
    if (dist === null) return
    expect(dist).toBeGreaterThan(0)
  })

  it('handles 8192-dimensional vectors', () => {
    const dim = 8192
    const a = new Float32Array(dim)
    const b = new Float32Array(dim)
    for (let i = 0; i < dim; i++) {
      a[i] = (i % 100) / 100.0
      b[i] = ((i + 50) % 100) / 100.0
    }

    const dot = simdDotProduct(a, b)
    expect(dot).not.toBeNull()
    if (dot === null) return
    expect(Number.isFinite(dot)).toBe(true)

    const sqDist = simdSquaredEuclideanDistance(a, b)
    expect(sqDist).not.toBeNull()
    if (sqDist === null) return
    expect(sqDist).toBeGreaterThanOrEqual(0)
  })

  it('triggers ensureMemory growth with a large single vector exceeding one WASM page', () => {
    const dim = 16384
    const a = new Float32Array(dim)
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i * 0.001)
    }

    const mag = simdMagnitude(a)
    expect(mag).not.toBeNull()
    if (mag === null) return
    expect(Number.isFinite(mag)).toBe(true)
    expect(mag).toBeGreaterThan(0)

    let jsSquaredSum = 0
    for (let i = 0; i < dim; i++) {
      jsSquaredSum += a[i] * a[i]
    }
    expect(mag).toBeCloseTo(Math.sqrt(jsSquaredSum), 0)
  })

  it('handles repeated memory growth with increasing vector sizes', () => {
    const dimensions = [16384, 32768]
    for (const dim of dimensions) {
      const v = new Float32Array(dim).fill(0.1)

      const mag = simdMagnitude(v)
      expect(mag).not.toBeNull()
      if (mag === null) return
      expect(mag).toBeCloseTo(Math.sqrt(0.01 * dim), 0)
    }
  })
})

describe('numerical stability with large values', () => {
  it('handles vectors with large component values', () => {
    const a = new Float32Array([1e6, 2e6, 3e6])
    const b = new Float32Array([4e6, 5e6, 6e6])

    const dot = simdDotProduct(a, b)
    expect(dot).not.toBeNull()
    if (dot === null) return
    expect(Number.isFinite(dot)).toBe(true)
    expect(dot).toBeCloseTo(4e12 + 10e12 + 18e12, -10)
  })

  it('handles vectors with small component values', () => {
    const a = new Float32Array([1e-6, 2e-6, 3e-6])
    const b = new Float32Array([4e-6, 5e-6, 6e-6])

    const dot = simdDotProduct(a, b)
    expect(dot).not.toBeNull()
    if (dot === null) return
    expect(Number.isFinite(dot)).toBe(true)
    expect(dot).toBeGreaterThan(0)
  })
})
