import { describe, expect, it } from 'vitest'
import { createScalarQuantizer } from '../../../vector/scalar-quantization'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

describe('ScalarQuantizer construction', () => {
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

describe('ScalarQuantizer calibration', () => {
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

describe('ScalarQuantizer quantize', () => {
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
