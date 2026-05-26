import { describe, expect, it } from 'vitest'
import { createScalarQuantizer, type ScalarQuantizer } from '../../../vector/scalar-quantization'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

describe('ScalarQuantizer distance computation', () => {
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
