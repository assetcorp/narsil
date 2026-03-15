import { describe, expect, it } from 'vitest'
import { createExecutionPromoter } from '../../workers/promoter'

describe('ExecutionPromoter', () => {
  describe('check', () => {
    it('returns shouldPromote false when all indexes are below thresholds', () => {
      const promoter = createExecutionPromoter()
      const indexes = new Map([
        ['products', { documentCount: 500 }],
        ['users', { documentCount: 1000 }],
      ])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(false)
      expect(result.reason).toBe('')
    })

    it('returns shouldPromote true when a single index exceeds perIndexThreshold', () => {
      const promoter = createExecutionPromoter()
      const indexes = new Map([
        ['products', { documentCount: 15_000 }],
        ['users', { documentCount: 500 }],
      ])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(true)
      expect(result.reason).toContain('products')
      expect(result.reason).toContain('15000')
    })

    it('returns shouldPromote true when the total document count exceeds totalThreshold', () => {
      const promoter = createExecutionPromoter()
      const indexes = new Map([
        ['products', { documentCount: 9000 }],
        ['users', { documentCount: 9000 }],
        ['orders', { documentCount: 9000 }],
        ['inventory', { documentCount: 9000 }],
        ['logs', { documentCount: 9000 }],
        ['metrics', { documentCount: 9000 }],
      ])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(true)
      expect(result.reason).toContain('total')
    })

    it('returns shouldPromote false for an empty index map', () => {
      const promoter = createExecutionPromoter()
      const result = promoter.check(new Map())
      expect(result.shouldPromote).toBe(false)
      expect(result.reason).toBe('')
    })

    it('returns shouldPromote false after markPromoted is called', () => {
      const promoter = createExecutionPromoter()
      const indexes = new Map([['products', { documentCount: 15_000 }]])

      const before = promoter.check(indexes)
      expect(before.shouldPromote).toBe(true)

      promoter.markPromoted()

      const after = promoter.check(indexes)
      expect(after.shouldPromote).toBe(false)
      expect(after.reason).toBe('')
    })
  })

  describe('markPromoted and isPromoted', () => {
    it('starts in a non-promoted state', () => {
      const promoter = createExecutionPromoter()
      expect(promoter.isPromoted()).toBe(false)
    })

    it('transitions to promoted after markPromoted', () => {
      const promoter = createExecutionPromoter()
      promoter.markPromoted()
      expect(promoter.isPromoted()).toBe(true)
    })

    it('is a one-way transition that stays promoted', () => {
      const promoter = createExecutionPromoter()
      promoter.markPromoted()
      expect(promoter.isPromoted()).toBe(true)
      expect(promoter.isPromoted()).toBe(true)
    })
  })

  describe('custom thresholds', () => {
    it('respects a custom perIndexThreshold', () => {
      const promoter = createExecutionPromoter({ perIndexThreshold: 100 })
      const indexes = new Map([['products', { documentCount: 150 }]])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(true)
      expect(result.reason).toContain('150')
    })

    it('respects a custom totalThreshold', () => {
      const promoter = createExecutionPromoter({ totalThreshold: 500 })
      const indexes = new Map([
        ['a', { documentCount: 200 }],
        ['b', { documentCount: 200 }],
        ['c', { documentCount: 200 }],
      ])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(true)
      expect(result.reason).toContain('total')
    })

    it('does not promote when below custom thresholds', () => {
      const promoter = createExecutionPromoter({
        perIndexThreshold: 1000,
        totalThreshold: 5000,
      })
      const indexes = new Map([
        ['a', { documentCount: 500 }],
        ['b', { documentCount: 500 }],
      ])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(false)
    })

    it('prioritizes perIndex check over total check', () => {
      const promoter = createExecutionPromoter({
        perIndexThreshold: 100,
        totalThreshold: 10_000,
      })
      const indexes = new Map([['products', { documentCount: 150 }]])
      const result = promoter.check(indexes)
      expect(result.shouldPromote).toBe(true)
      expect(result.reason).toContain('products')
    })
  })
})
