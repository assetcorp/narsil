import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { validateVectorPromotion } from '../../../schema/validator'

describe('validateVectorPromotion', () => {
  it('accepts an omitted config', () => {
    expect(() => validateVectorPromotion(undefined)).not.toThrow()
  })

  it('accepts a config that leaves the threshold to the default', () => {
    expect(() => validateVectorPromotion({ filterThreshold: 0.1 })).not.toThrow()
  })

  it('accepts positive integer thresholds', () => {
    expect(() => validateVectorPromotion({ threshold: 1 })).not.toThrow()
    expect(() => validateVectorPromotion({ threshold: 1024 })).not.toThrow()
    expect(() => validateVectorPromotion({ threshold: 5_000_000 })).not.toThrow()
  })

  it('rejects zero and negative thresholds that would rebuild on every insert', () => {
    for (const threshold of [0, -1, -1024]) {
      expect(() => validateVectorPromotion({ threshold })).toThrow(NarsilError)
    }
  })

  it('rejects non-integer and non-finite thresholds', () => {
    for (const threshold of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateVectorPromotion({ threshold })).toThrow(NarsilError)
    }
  })

  it('rejects a non-numeric threshold that arrives untyped over HTTP', () => {
    expect(() => validateVectorPromotion({ threshold: 'abc' as unknown as number })).toThrow(NarsilError)
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
