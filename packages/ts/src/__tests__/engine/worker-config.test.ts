import { describe, expect, it } from 'vitest'
import { validateWorkerConfig } from '../../engine/validation'
import { ErrorCodes, NarsilError } from '../../errors'

function codeOf(run: () => void): string | null {
  try {
    run()
    return null
  } catch (err) {
    return err instanceof NarsilError ? err.code : 'not-a-narsil-error'
  }
}

describe('validateWorkerConfig', () => {
  it('accepts an absent config and an empty one', () => {
    expect(codeOf(() => validateWorkerConfig(undefined))).toBeNull()
    expect(codeOf(() => validateWorkerConfig({}))).toBeNull()
  })

  it('accepts positive integers for the count, the copy threshold, and the idle timeout', () => {
    expect(codeOf(() => validateWorkerConfig({ count: 3, promotionThreshold: 1, idleTimeoutMs: 1 }))).toBeNull()
  })

  it('rejects a zero, negative, fractional, or unsafe count', () => {
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(codeOf(() => validateWorkerConfig({ count }))).toBe(ErrorCodes.CONFIG_INVALID)
    }
  })

  it('rejects a copy threshold below one', () => {
    expect(codeOf(() => validateWorkerConfig({ promotionThreshold: 0 }))).toBe(ErrorCodes.CONFIG_INVALID)
    expect(codeOf(() => validateWorkerConfig({ promotionThreshold: 2.5 }))).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it('rejects an idle timeout below one millisecond', () => {
    expect(codeOf(() => validateWorkerConfig({ idleTimeoutMs: 0 }))).toBe(ErrorCodes.CONFIG_INVALID)
    expect(codeOf(() => validateWorkerConfig({ idleTimeoutMs: -5 }))).toBe(ErrorCodes.CONFIG_INVALID)
  })
})
