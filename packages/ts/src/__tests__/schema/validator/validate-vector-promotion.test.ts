import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { validateVectorPromotion } from '../../../schema/validator'

describe('validateVectorPromotion', () => {
  it('accepts an omitted config', () => {
    expect(() => validateVectorPromotion(undefined)).not.toThrow()
  })

  it('accepts a config that leaves every knob to its default', () => {
    expect(() => validateVectorPromotion({ filterThreshold: 0.1 })).not.toThrow()
  })

  describe('threshold', () => {
    it('accepts positive integers', () => {
      expect(() => validateVectorPromotion({ threshold: 1 })).not.toThrow()
      expect(() => validateVectorPromotion({ threshold: 1024 })).not.toThrow()
      expect(() => validateVectorPromotion({ threshold: 5_000_000 })).not.toThrow()
    })

    it('rejects zero and negative values that would rebuild on every insert', () => {
      for (const threshold of [0, -1, -1024]) {
        expect(() => validateVectorPromotion({ threshold })).toThrow(NarsilError)
      }
    })

    it('rejects non-integer, non-finite, and non-numeric values', () => {
      for (const threshold of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc' as unknown as number]) {
        expect(() => validateVectorPromotion({ threshold })).toThrow(NarsilError)
      }
    })
  })

  describe('quantization', () => {
    it("accepts 'sq8' and 'none'", () => {
      expect(() => validateVectorPromotion({ quantization: 'sq8' })).not.toThrow()
      expect(() => validateVectorPromotion({ quantization: 'none' })).not.toThrow()
    })

    it('rejects an unknown mode instead of silently disabling quantization', () => {
      expect(() => validateVectorPromotion({ quantization: 'sq16' as unknown as 'sq8' })).toThrow(NarsilError)
    })
  })

  describe('hnswConfig', () => {
    it('accepts valid graph parameters', () => {
      expect(() =>
        validateVectorPromotion({ hnswConfig: { m: 16, efConstruction: 200, metric: 'cosine' } }),
      ).not.toThrow()
    })

    it('rejects a non-positive-integer m that would reach the graph as NaN', () => {
      for (const m of [0, -4, 1.5, 'abc' as unknown as number]) {
        expect(() => validateVectorPromotion({ hnswConfig: { m } })).toThrow(NarsilError)
      }
    })

    it('rejects a non-positive-integer efConstruction', () => {
      for (const efConstruction of [0, -1, 2.5, Number.NaN]) {
        expect(() => validateVectorPromotion({ hnswConfig: { efConstruction } })).toThrow(NarsilError)
      }
    })

    it('rejects an unknown metric', () => {
      expect(() => validateVectorPromotion({ hnswConfig: { metric: 'manhattan' as unknown as 'cosine' } })).toThrow(
        NarsilError,
      )
    })
  })

  it('reports the CONFIG_INVALID code', () => {
    let caught: unknown
    try {
      validateVectorPromotion({ threshold: 0 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NarsilError)
    expect((caught as NarsilError).code).toBe(ErrorCodes.CONFIG_INVALID)
  })
})
