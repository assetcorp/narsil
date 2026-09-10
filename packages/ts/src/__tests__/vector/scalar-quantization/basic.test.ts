import { describe, expect, it } from 'vitest'
import { createQuantizerHarness, DIM, normalizedVector, vectorFromValues } from './fixtures'

describe('ScalarQuantizer construction', () => {
  it('creates with correct dimensions', () => {
    const { sq } = createQuantizerHarness(DIM)
    expect(sq.dimensions).toBe(DIM)
  })

  it('starts uncalibrated', () => {
    const { sq } = createQuantizerHarness(DIM)
    expect(sq.isCalibrated()).toBe(false)
  })

  it('starts with size 0', () => {
    const { sq } = createQuantizerHarness(DIM)
    expect(sq.size).toBe(0)
  })
})

describe('ScalarQuantizer calibration', () => {
  it('sets min/max from a set of vectors', () => {
    const { sq } = createQuantizerHarness(DIM)
    const vectors = [normalizedVector(DIM, 1), normalizedVector(DIM, 2), normalizedVector(DIM, 3)]

    sq.calibrate(vectors)
    expect(sq.isCalibrated()).toBe(true)
  })

  it('calibrating with empty iterator is a no-op', () => {
    const { sq } = createQuantizerHarness(DIM)
    sq.calibrate([])
    expect(sq.isCalibrated()).toBe(false)
  })

  it('handles uniform values where all components are identical', () => {
    const harness = createQuantizerHarness(4)
    const uniform = vectorFromValues(0.5, 0.5, 0.5, 0.5)
    harness.sq.calibrate([uniform])
    expect(harness.sq.isCalibrated()).toBe(true)

    harness.quantize('doc1', uniform)
    expect(harness.sq.size).toBe(1)
    expect(harness.sq.getQuantized('doc1')).toBeDefined()
  })
})

describe('ScalarQuantizer quantize', () => {
  it('stores a quantized representation', () => {
    const harness = createQuantizerHarness(DIM)
    const v = normalizedVector(DIM, 1)
    harness.sq.calibrate([v, normalizedVector(DIM, 2)])
    harness.quantize('doc1', v)

    const quantized = harness.sq.getQuantized('doc1')
    expect(quantized).toBeInstanceOf(Uint8Array)
    if (quantized) {
      expect(quantized.length).toBe(DIM)
    }
  })

  it('increases size after quantize', () => {
    const harness = createQuantizerHarness(DIM)
    const vectors = [normalizedVector(DIM, 1), normalizedVector(DIM, 2)]
    harness.sq.calibrate(vectors)

    expect(harness.sq.size).toBe(0)
    harness.quantize('doc1', vectors[0])
    expect(harness.sq.size).toBe(1)
    harness.quantize('doc2', vectors[1])
    expect(harness.sq.size).toBe(2)
  })

  it('auto-calibrates when quantizing before explicit calibration', () => {
    const harness = createQuantizerHarness(DIM)
    const v = normalizedVector(DIM, 1)

    harness.quantize('doc1', v)
    expect(harness.sq.isCalibrated()).toBe(true)
    expect(harness.sq.size).toBe(1)
  })
})
