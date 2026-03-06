import { describe, expect, it } from 'vitest'
import { computeBM25, computeBM25WithGlobalStats, computeIDF } from '../../core/scorer'

describe('computeIDF', () => {
  it('returns 0 for an empty corpus', () => {
    expect(computeIDF(0, 0)).toBe(0)
  })

  it('returns a high value for a rare term', () => {
    const idf = computeIDF(1, 10000)
    expect(idf).toBeGreaterThan(8)
  })

  it('returns a value near zero when the term appears in every document', () => {
    const idf = computeIDF(1000, 1000)
    expect(idf).toBeGreaterThanOrEqual(0)
    expect(idf).toBeLessThan(0.01)
  })

  it('is always non-negative', () => {
    for (let n = 0; n <= 100; n += 10) {
      const idf = computeIDF(n, 100)
      expect(idf).toBeGreaterThanOrEqual(0)
    }
  })

  it('decreases as the term appears in more documents', () => {
    const idfRare = computeIDF(1, 1000)
    const idfCommon = computeIDF(500, 1000)
    expect(idfRare).toBeGreaterThan(idfCommon)
  })

  it('matches the BM25 IDF formula for known values', () => {
    const N = 100
    const n = 10
    const expected = Math.log((N - n + 0.5) / (n + 0.5) + 1)
    expect(computeIDF(n, N)).toBeCloseTo(expected, 10)
  })
})

describe('computeBM25', () => {
  it('returns 0 for an empty corpus', () => {
    expect(computeBM25(3, 10, 0, 100, 120)).toBe(0)
  })

  it('returns 0 when average field length is 0', () => {
    expect(computeBM25(3, 10, 100, 50, 0)).toBe(0)
  })

  it('returns 0 when field length is 0 and b is 1 (division by zero guard)', () => {
    const score = computeBM25(0, 10, 100, 0, 120, { k1: 1.2, b: 1 })
    expect(score).toBe(0)
  })

  it('computes a positive score for a typical query', () => {
    const score = computeBM25(3, 10, 1000, 100, 120)
    expect(score).toBeGreaterThan(0)
  })

  it('uses default k1=1.2 and b=0.75 when params are omitted', () => {
    const withDefaults = computeBM25(3, 10, 1000, 100, 120)
    const withExplicit = computeBM25(3, 10, 1000, 100, 120, { k1: 1.2, b: 0.75 })
    expect(withDefaults).toBe(withExplicit)
  })

  it('scores higher for rarer terms', () => {
    const scoreRare = computeBM25(2, 5, 10000, 100, 120)
    const scoreCommon = computeBM25(2, 5000, 10000, 100, 120)
    expect(scoreRare).toBeGreaterThan(scoreCommon)
  })

  it('scores higher for more frequent terms in the document', () => {
    const scoreLow = computeBM25(1, 50, 1000, 100, 120)
    const scoreHigh = computeBM25(5, 50, 1000, 100, 120)
    expect(scoreHigh).toBeGreaterThan(scoreLow)
  })

  it('saturates with increasing term frequency (diminishing returns)', () => {
    const score5 = computeBM25(5, 50, 1000, 100, 120)
    const score10 = computeBM25(10, 50, 1000, 100, 120)
    const score100 = computeBM25(100, 50, 1000, 100, 120)
    const gain5to10 = score10 - score5
    const gain10to100 = score100 - score10
    expect(gain10to100 / 90).toBeLessThan(gain5to10 / 5)
  })

  it('penalizes longer documents when b > 0', () => {
    const scoreShort = computeBM25(3, 50, 1000, 50, 120)
    const scoreLong = computeBM25(3, 50, 1000, 300, 120)
    expect(scoreShort).toBeGreaterThan(scoreLong)
  })

  it('ignores document length when b = 0', () => {
    const scoreShort = computeBM25(3, 50, 1000, 50, 120, { b: 0 })
    const scoreLong = computeBM25(3, 50, 1000, 300, 120, { b: 0 })
    expect(scoreShort).toBeCloseTo(scoreLong, 10)
  })

  it('respects custom k1 values', () => {
    const lowK1 = computeBM25(5, 50, 1000, 100, 120, { k1: 0.5 })
    const highK1 = computeBM25(5, 50, 1000, 100, 120, { k1: 3.0 })
    expect(lowK1).not.toBe(highK1)
  })

  it('matches the full BM25 formula for a hand-computed case', () => {
    const tf = 4
    const df = 20
    const N = 500
    const dl = 80
    const avgdl = 100
    const k1 = 1.2
    const b = 0.75

    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * (1 - b + (b * dl) / avgdl)
    const expected = idf * (numerator / denominator)

    expect(computeBM25(tf, df, N, dl, avgdl, { k1, b })).toBeCloseTo(expected, 10)
  })
})

describe('computeBM25WithGlobalStats', () => {
  it('produces the same result as computeBM25 with identical parameters', () => {
    const local = computeBM25(3, 50, 5000, 100, 120)
    const global = computeBM25WithGlobalStats(3, 50, 5000, 100, 120)
    expect(global).toBe(local)
  })

  it('uses different global statistics to produce a different score', () => {
    const localScore = computeBM25(3, 10, 1000, 100, 120)
    const globalScore = computeBM25WithGlobalStats(3, 100, 10000, 100, 150)
    expect(localScore).not.toBe(globalScore)
  })

  it('passes custom BM25 params through', () => {
    const params = { k1: 0.8, b: 0.4 }
    const fromBM25 = computeBM25(3, 50, 5000, 100, 120, params)
    const fromGlobal = computeBM25WithGlobalStats(3, 50, 5000, 100, 120, params)
    expect(fromGlobal).toBe(fromBM25)
  })
})
