import { describe, expect, it } from 'vitest'
import type { FilterExpression } from '../../../types/filters'
import { buildContext, resultSet } from './fixtures'

describe('evaluateFilters fields and logical combinators', () => {
  const ctx = buildContext()

  it('returns all doc IDs for an empty expression', () => {
    expect(resultSet({}, ctx)).toEqual(ctx.allDocIds)
  })

  describe('single field filters', () => {
    it('filters by numeric eq using index', () => {
      const expr: FilterExpression = { fields: { price: { eq: 999 } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([0]))
    })

    it('filters by numeric range using index', () => {
      const expr: FilterExpression = { fields: { price: { gt: 100 } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 3]))
    })

    it('filters by boolean using index', () => {
      const expr: FilterExpression = { fields: { inStock: { eq: true } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('filters by enum using index', () => {
      const expr: FilterExpression = { fields: { category: { eq: 'books' } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([1, 4]))
    })

    it('filters by string scan (no index for name)', () => {
      const expr: FilterExpression = { fields: { name: { startsWith: 'Head' } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([3]))
    })

    it('filters by array containsAll', () => {
      const expr: FilterExpression = { fields: { tags: { containsAll: ['tech', 'audio'] } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([3]))
    })

    it('filters by array matchesAny', () => {
      const expr: FilterExpression = { fields: { tags: { matchesAny: ['fiction', 'cotton'] } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([1, 2]))
    })

    it('filters by array size', () => {
      const expr: FilterExpression = { fields: { tags: { size: { eq: 0 } } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([4]))
    })
  })

  describe('multiple operators on one field (AND logic)', () => {
    it('combines gt and lt for a range', () => {
      const expr: FilterExpression = { fields: { price: { gt: 20, lt: 200 } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([2, 3, 4]))
    })

    it('combines gte and lte', () => {
      const expr: FilterExpression = { fields: { price: { gte: 25, lte: 199 } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([2, 3, 4]))
    })
  })

  describe('multiple field filters (AND across fields)', () => {
    it('intersects results from different fields', () => {
      const expr: FilterExpression = {
        fields: {
          category: { eq: 'electronics' },
          price: { lt: 500 },
        },
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([3]))
    })
  })

  describe('logical combinators', () => {
    it('evaluates AND combinator', () => {
      const expr: FilterExpression = {
        and: [{ fields: { inStock: { eq: true } } }, { fields: { price: { lt: 50 } } }],
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([1]))
    })

    it('evaluates OR combinator', () => {
      const expr: FilterExpression = {
        or: [{ fields: { category: { eq: 'electronics' } } }, { fields: { category: { eq: 'books' } } }],
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 1, 3, 4]))
    })

    it('evaluates NOT combinator', () => {
      const expr: FilterExpression = {
        not: { fields: { inStock: { eq: false } } },
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('combines fields with OR', () => {
      const expr: FilterExpression = {
        fields: { price: { gt: 100 } },
        or: [{ fields: { category: { eq: 'books' } } }, { fields: { category: { eq: 'clothing' } } }],
      }
      expect(resultSet(expr, ctx)).toEqual(new Set())
    })

    it('combines fields with NOT', () => {
      const expr: FilterExpression = {
        fields: { inStock: { eq: true } },
        not: { fields: { category: { eq: 'electronics' } } },
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([1]))
    })
  })

  describe('nested expressions', () => {
    it('handles deeply nested and/or', () => {
      const expr: FilterExpression = {
        and: [
          {
            or: [{ fields: { category: { eq: 'electronics' } } }, { fields: { category: { eq: 'books' } } }],
          },
          { fields: { inStock: { eq: true } } },
        ],
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('handles not inside and', () => {
      const expr: FilterExpression = {
        and: [{ fields: { inStock: { eq: true } } }, { not: { fields: { price: { gt: 500 } } } }],
      }
      expect(resultSet(expr, ctx)).toEqual(new Set([1, 3]))
    })
  })
})
