import { describe, expect, it } from 'vitest'
import { deserializeScalarQuantizer } from '../../../vector/scalar-quantization-restore'
import { createQuantizerHarness, DIM, normalizedVector, vectorFromValues } from './fixtures'

describe('ScalarQuantizer recalibration', () => {
  it('updates min/max and re-quantizes stored vectors', () => {
    const harness = createQuantizerHarness(DIM)
    const v1 = normalizedVector(DIM, 1)
    const v2 = normalizedVector(DIM, 2)
    harness.sq.calibrate([v1, v2])
    harness.quantize('doc1', v1)
    harness.quantize('doc2', v2)

    const wideRange = vectorFromValues(...Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 10 : -10)))
    harness.recalibrateAll([
      ['doc1', v1],
      ['doc2', v2],
      ['doc3', wideRange],
    ])

    expect(harness.sq.size).toBe(3)
    expect(harness.sq.isCalibrated()).toBe(true)
  })

  it('still produces correct distance ordering after recalibration', () => {
    const harness = createQuantizerHarness(DIM)
    const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

    harness.sq.calibrate([query, near, far])
    harness.quantize('near', near)
    harness.quantize('far', far)

    const outlier = vectorFromValues(...Array.from({ length: DIM }, (_, i) => (i === 0 ? 5 : -5)))
    harness.recalibrateAll([
      ['near', near],
      ['far', far],
      ['outlier', outlier],
    ])

    const prepared = harness.sq.prepareQuery(query)
    if (!prepared) throw new Error('prepareQuery returned null')

    const distNear = harness.sq.distanceFromPrepared(prepared, 'near', 'cosine')
    const distFar = harness.sq.distanceFromPrepared(prepared, 'far', 'cosine')
    expect(distNear).toBeLessThan(distFar)
  })
})

describe('ScalarQuantizer needsRecalibration', () => {
  it('returns false when uncalibrated', () => {
    const { sq } = createQuantizerHarness(DIM)
    const v = normalizedVector(DIM, 1)
    expect(sq.needsRecalibration(v)).toBe(false)
  })

  it('returns false for vectors within calibrated bounds', () => {
    const { sq } = createQuantizerHarness(DIM)
    const v1 = normalizedVector(DIM, 1)
    const v2 = normalizedVector(DIM, 2)
    sq.calibrate([v1, v2])

    expect(sq.needsRecalibration(v1)).toBe(false)
  })

  it('returns true for vectors outside calibrated bounds', () => {
    const { sq } = createQuantizerHarness(4)
    sq.calibrate([vectorFromValues(0, 0, 0, 0), vectorFromValues(1, 1, 1, 1)])

    const outsideBounds = vectorFromValues(100, 100, 100, 100)
    expect(sq.needsRecalibration(outsideBounds)).toBe(true)
  })
})

describe('ScalarQuantizer serialization', () => {
  it('serialize returns SerializedSQ8 with correct fields', () => {
    const harness = createQuantizerHarness(DIM)
    const v = normalizedVector(DIM, 1)
    harness.sq.calibrate([v])
    harness.quantize('doc1', v)

    const serialized = harness.sq.serialize()
    expect(typeof serialized.alpha).toBe('number')
    expect(typeof serialized.offset).toBe('number')
    expect(serialized.quantizedVectors).toBeDefined()
    expect(serialized.vectorSums).toBeDefined()
    expect(serialized.vectorSumSqs).toBeDefined()
    expect(serialized.quantizedVectors.doc1).toBeDefined()
    expect(Array.isArray(serialized.quantizedVectors.doc1)).toBe(true)
  })

  it('deserializeScalarQuantizer restores a working quantizer', () => {
    const harness = createQuantizerHarness(DIM)
    const v1 = normalizedVector(DIM, 1)
    const v2 = normalizedVector(DIM, 2)
    harness.sq.calibrate([v1, v2])
    harness.quantize('doc1', v1)
    harness.quantize('doc2', v2)

    const serialized = harness.sq.serialize()
    const restored = deserializeScalarQuantizer(serialized, DIM, harness.store)

    expect(restored.isCalibrated()).toBe(true)
    expect(restored.size).toBe(2)
    expect(restored.dimensions).toBe(DIM)
    expect(restored.getQuantized('doc1')).toBeDefined()
    expect(restored.getQuantized('doc2')).toBeDefined()
  })

  it('round-trip preserves distance ordering', () => {
    const harness = createQuantizerHarness(DIM)
    const query = vectorFromValues(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const near = vectorFromValues(0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    const far = vectorFromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)

    harness.sq.calibrate([query, near, far])
    harness.quantize('near', near)
    harness.quantize('far', far)

    const serialized = harness.sq.serialize()
    const restored = deserializeScalarQuantizer(serialized, DIM, harness.store)

    const prepared = restored.prepareQuery(query)
    if (!prepared) throw new Error('prepareQuery returned null after deserialization')

    const distNear = restored.distanceFromPrepared(prepared, 'near', 'cosine')
    const distFar = restored.distanceFromPrepared(prepared, 'far', 'cosine')
    expect(distNear).toBeLessThan(distFar)
  })

  it('deserializes empty quantizer correctly', () => {
    const harness = createQuantizerHarness(DIM)
    const serialized = harness.sq.serialize()
    const restored = deserializeScalarQuantizer(serialized, DIM, harness.store)

    expect(restored.isCalibrated()).toBe(false)
    expect(restored.size).toBe(0)
  })
})

describe('ScalarQuantizer remove and clear', () => {
  it('remove decreases size', () => {
    const harness = createQuantizerHarness(DIM)
    const v1 = normalizedVector(DIM, 1)
    const v2 = normalizedVector(DIM, 2)
    harness.sq.calibrate([v1, v2])
    harness.quantize('doc1', v1)
    harness.quantize('doc2', v2)

    expect(harness.sq.size).toBe(2)
    harness.sq.remove('doc1')
    expect(harness.sq.size).toBe(1)
    expect(harness.sq.getQuantized('doc1')).toBeUndefined()
    expect(harness.sq.getQuantized('doc2')).toBeDefined()
  })

  it('clear resets to empty uncalibrated state', () => {
    const harness = createQuantizerHarness(DIM)
    const v = normalizedVector(DIM, 1)
    harness.sq.calibrate([v])
    harness.quantize('doc1', v)

    harness.sq.clear()
    expect(harness.sq.size).toBe(0)
    expect(harness.sq.isCalibrated()).toBe(false)
    expect(harness.sq.getQuantized('doc1')).toBeUndefined()
  })

  it('remove with nonexistent docId is safe', () => {
    const { sq } = createQuantizerHarness(DIM)
    expect(() => sq.remove('nonexistent')).not.toThrow()
  })
})
