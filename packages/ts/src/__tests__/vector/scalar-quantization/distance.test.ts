import { describe, expect, it } from 'vitest'
import { createQuantizerHarness, DIM, normalizedVector, type QuantizerHarness, vectorFromValues } from './fixtures'

describe('ScalarQuantizer distance computation', () => {
  let harness: QuantizerHarness
  const queryVec = normalizedVector(DIM, 10)
  const nearVec = normalizedVector(DIM, 10.1)
  const farVec = normalizedVector(DIM, 99)

  function setupQuantizer(): void {
    harness = createQuantizerHarness(DIM)
    const allVecs = [queryVec, nearVec, farVec, normalizedVector(DIM, 50)]
    harness.sq.calibrate(allVecs)
    harness.quantize('near', nearVec)
    harness.quantize('far', farVec)
  }

  function separated(): QuantizerHarness {
    const separatedHarness = createQuantizerHarness(DIM)
    const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
    separatedHarness.sq.calibrate([query, near, far])
    separatedHarness.quantize('near', near)
    separatedHarness.quantize('far', far)
    return separatedHarness
  }

  it('prepareQuery returns a QuantizedQuery object', () => {
    setupQuantizer()
    const prepared = harness.sq.prepareQuery(queryVec)
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
    const uncalibrated = createQuantizerHarness(DIM)
    expect(uncalibrated.sq.prepareQuery(queryVec)).toBeNull()
  })

  it('cosine metric produces scores in 0-1 range for normalized vectors', () => {
    setupQuantizer()
    const prepared = harness.sq.prepareQuery(queryVec)
    if (!prepared) throw new Error('prepareQuery returned null')

    const distNear = harness.sq.distanceFromPrepared(prepared, 'near', 'cosine')
    const distFar = harness.sq.distanceFromPrepared(prepared, 'far', 'cosine')

    expect(distNear).toBeGreaterThanOrEqual(-0.1)
    expect(distNear).toBeLessThanOrEqual(2.1)
    expect(distFar).toBeGreaterThanOrEqual(-0.1)
    expect(distFar).toBeLessThanOrEqual(2.1)
  })

  it('dotProduct metric produces finite values', () => {
    setupQuantizer()
    const prepared = harness.sq.prepareQuery(queryVec)
    if (!prepared) throw new Error('prepareQuery returned null')

    const distNear = harness.sq.distanceFromPrepared(prepared, 'near', 'dotProduct')
    const distFar = harness.sq.distanceFromPrepared(prepared, 'far', 'dotProduct')

    expect(Number.isFinite(distNear)).toBe(true)
    expect(Number.isFinite(distFar)).toBe(true)
  })

  it('euclidean metric produces non-negative values', () => {
    setupQuantizer()
    const prepared = harness.sq.prepareQuery(queryVec)
    if (!prepared) throw new Error('prepareQuery returned null')

    const distNear = harness.sq.distanceFromPrepared(prepared, 'near', 'euclidean')
    const distFar = harness.sq.distanceFromPrepared(prepared, 'far', 'euclidean')

    expect(distNear).toBeGreaterThanOrEqual(0)
    expect(distFar).toBeGreaterThanOrEqual(0)
  })

  it('preserves distance ordering for well-separated vectors with cosine', () => {
    const { sq } = separated()
    const prepared = sq.prepareQuery(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    if (!prepared) throw new Error('prepareQuery returned null')

    expect(sq.distanceFromPrepared(prepared, 'near', 'cosine')).toBeLessThan(
      sq.distanceFromPrepared(prepared, 'far', 'cosine'),
    )
  })

  it('preserves distance ordering for well-separated vectors with euclidean', () => {
    const { sq } = separated()
    const prepared = sq.prepareQuery(vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    if (!prepared) throw new Error('prepareQuery returned null')

    expect(sq.distanceFromPrepared(prepared, 'near', 'euclidean')).toBeLessThan(
      sq.distanceFromPrepared(prepared, 'far', 'euclidean'),
    )
  })

  it('preserves distance ordering for well-separated vectors with dotProduct', () => {
    const dotHarness = createQuantizerHarness(DIM)
    const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const highDp = vectorFromValues(10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const lowDp = vectorFromValues(0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    dotHarness.sq.calibrate([query, highDp, lowDp])
    dotHarness.quantize('highDp', highDp)
    dotHarness.quantize('lowDp', lowDp)

    const prepared = dotHarness.sq.prepareQuery(query)
    if (!prepared) throw new Error('prepareQuery returned null')

    expect(dotHarness.sq.distanceFromPrepared(prepared, 'highDp', 'dotProduct')).toBeLessThan(
      dotHarness.sq.distanceFromPrepared(prepared, 'lowDp', 'dotProduct'),
    )
  })

  it('returns POSITIVE_INFINITY for nonexistent docId', () => {
    setupQuantizer()
    const prepared = harness.sq.prepareQuery(queryVec)
    if (!prepared) throw new Error('prepareQuery returned null')

    expect(harness.sq.distanceFromPrepared(prepared, 'nonexistent', 'cosine')).toBe(Number.POSITIVE_INFINITY)
  })
})
