import { describe, expect, it } from 'vitest'
import { suggestNodeLimit } from '../../../distribution/cluster-node/reads/terms'
import { MAX_SUGGEST_LIMIT, MAX_SUGGEST_SCATTER_LIMIT } from '../../../engine/suggest'

describe('suggest per-node oversample', () => {
  it('asks each node for half as many again as the caller wants, plus a margin', () => {
    expect(suggestNodeLimit(10)).toBe(25)
    expect(suggestNodeLimit(40)).toBe(70)
  })

  it('keeps oversampling at the largest limit a caller may ask for', () => {
    expect(suggestNodeLimit(MAX_SUGGEST_LIMIT)).toBeGreaterThan(MAX_SUGGEST_LIMIT)
    expect(suggestNodeLimit(MAX_SUGGEST_LIMIT)).toBe(160)
  })

  it('oversamples by the same proportion across the whole client range', () => {
    for (let clientLimit = 1; clientLimit <= MAX_SUGGEST_LIMIT; clientLimit += 1) {
      expect(suggestNodeLimit(clientLimit)).toBeGreaterThanOrEqual(clientLimit * 1.5)
    }
  })

  it('never asks a node for more than the scatter ceiling', () => {
    expect(suggestNodeLimit(MAX_SUGGEST_LIMIT)).toBeLessThanOrEqual(MAX_SUGGEST_SCATTER_LIMIT)
    expect(suggestNodeLimit(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(MAX_SUGGEST_SCATTER_LIMIT)
  })
})
