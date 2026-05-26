import { describe, expect, it } from 'vitest'
import { bitsetFromSet } from '../../../core/bitset'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { FilterContext } from '../../../filters/evaluator'
import { evaluateFilters } from '../../../filters/evaluator'
import type { FieldIndex, GeoFieldIndex } from '../../../filters/operators'
import type { FilterExpression } from '../../../types/filters'
import { buildContext, resultSet } from './fixtures'

describe('evaluateFilters operators, presence, and geo', () => {
  const ctx = buildContext()

  describe('presence filters', () => {
    const sparseProducts: Record<number, Record<string, unknown>> = {
      0: { name: 'A', rating: 4.5 },
      1: { name: 'B' },
      2: { name: 'C', rating: null },
      3: { name: 'D', rating: 3.0 },
    }
    const sparseAllDocIds = new Set([0, 1, 2, 3])
    const sparseCtx: FilterContext = {
      fieldIndexes: {},
      getFieldValue: (id, field) => sparseProducts[id]?.[field],
      allDocIds: sparseAllDocIds,
      capacity: 4,
      allDocIdsBitset: bitsetFromSet(sparseAllDocIds, 4),
    }

    it('filters by exists: true', () => {
      const expr: FilterExpression = { fields: { rating: { exists: true } } }
      expect(resultSet(expr, sparseCtx)).toEqual(new Set([0, 3]))
    })

    it('filters by exists: false', () => {
      const expr: FilterExpression = { fields: { rating: { exists: false } } }
      expect(resultSet(expr, sparseCtx)).toEqual(new Set([1, 2]))
    })

    it('filters by notExists: true', () => {
      const expr: FilterExpression = { fields: { rating: { notExists: true } } }
      expect(resultSet(expr, sparseCtx)).toEqual(new Set([1, 2]))
    })
  })

  describe('isEmpty / isNotEmpty', () => {
    const dataProducts: Record<number, Record<string, unknown>> = {
      0: { label: 'hello', items: ['x'] },
      1: { label: '', items: [] },
      2: { items: ['a', 'b'] },
    }
    const emptyAllDocIds = new Set([0, 1, 2])
    const emptyCtx: FilterContext = {
      fieldIndexes: {},
      getFieldValue: (id, field) => dataProducts[id]?.[field],
      allDocIds: emptyAllDocIds,
      capacity: 3,
      allDocIdsBitset: bitsetFromSet(emptyAllDocIds, 3),
    }

    it('isEmpty: true matches empty strings, empty arrays, and missing fields', () => {
      const expr: FilterExpression = { fields: { label: { isEmpty: true } } }
      expect(resultSet(expr, emptyCtx)).toEqual(new Set([1, 2]))
    })

    it('isNotEmpty: true matches non-empty values', () => {
      const expr: FilterExpression = { fields: { label: { isNotEmpty: true } } }
      expect(resultSet(expr, emptyCtx)).toEqual(new Set([0]))
    })
  })

  describe('enum in/nin operators', () => {
    it('filters by in using enum index', () => {
      const expr: FilterExpression = { fields: { category: { in: ['electronics', 'clothing'] } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([0, 2, 3]))
    })

    it('filters by nin using enum index', () => {
      const expr: FilterExpression = { fields: { category: { nin: ['electronics'] } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([1, 2, 4]))
    })
  })

  describe('between operator', () => {
    it('filters by between range using numeric index', () => {
      const expr: FilterExpression = { fields: { price: { between: [20, 100] } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([2, 4]))
    })
  })

  describe('ne operator', () => {
    it('filters by ne using numeric index', () => {
      const expr: FilterExpression = { fields: { price: { ne: 999 } } }
      const result = resultSet(expr, ctx)
      expect(result.has(0)).toBe(false)
      expect(result.size).toBe(4)
    })

    it('filters by ne on enum using index', () => {
      const expr: FilterExpression = { fields: { category: { ne: 'electronics' } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([1, 2, 4]))
    })
  })

  describe('geo filters', () => {
    it('throws when geo filter is applied to a non-geopoint field', () => {
      const expr: FilterExpression = {
        fields: { price: { radius: { lat: 40, lon: -74, distance: 10, unit: 'km' } } },
      }
      expect(() => evaluateFilters(expr, ctx)).toThrow(NarsilError)
      try {
        evaluateFilters(expr, ctx)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_FILTER)
      }
    })

    it('evaluates geo radius filter with geopoint index', () => {
      const geoAllDocIds = new Set([0, 1, 2, 3])
      const geoIdx: FieldIndex = {
        type: 'geopoint',
        index: {
          radiusQuery: () => new Set([0, 3]),
          polygonQuery: () => new Set(),
        } as GeoFieldIndex,
      }
      const geoCtx: FilterContext = {
        fieldIndexes: { location: geoIdx },
        getFieldValue: () => undefined,
        allDocIds: geoAllDocIds,
        capacity: 4,
        allDocIdsBitset: bitsetFromSet(geoAllDocIds, 4),
      }
      const expr: FilterExpression = {
        fields: { location: { radius: { lat: 40.7, lon: -74.0, distance: 10, unit: 'km' } } },
      }
      expect(resultSet(expr, geoCtx)).toEqual(new Set([0, 3]))
    })

    it('evaluates geo polygon filter with geopoint index', () => {
      const geoAllDocIds = new Set([0, 1, 2])
      const geoIdx: FieldIndex = {
        type: 'geopoint',
        index: {
          radiusQuery: () => new Set(),
          polygonQuery: () => new Set([1]),
        } as GeoFieldIndex,
      }
      const geoCtx: FilterContext = {
        fieldIndexes: { location: geoIdx },
        getFieldValue: () => undefined,
        allDocIds: geoAllDocIds,
        capacity: 3,
        allDocIdsBitset: bitsetFromSet(geoAllDocIds, 3),
      }
      const expr: FilterExpression = {
        fields: {
          location: {
            polygon: {
              points: [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 0 },
                { lat: 1, lon: 1 },
              ],
            },
          },
        },
      }
      expect(resultSet(expr, geoCtx)).toEqual(new Set([1]))
    })

    it('throws when geo polygon filter has no geopoint index', () => {
      const expr: FilterExpression = {
        fields: {
          name: {
            polygon: {
              points: [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 0 },
                { lat: 1, lon: 1 },
              ],
            },
          },
        },
      }
      expect(() => evaluateFilters(expr, ctx)).toThrow(NarsilError)
    })
  })

  describe('edge cases', () => {
    it('ignores empty and array', () => {
      const expr: FilterExpression = { and: [] }
      expect(resultSet(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('ignores empty or array', () => {
      const expr: FilterExpression = { or: [] }
      expect(resultSet(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('handles field filter with no recognized operators as match-all', () => {
      const expr: FilterExpression = { fields: { price: {} } }
      expect(resultSet(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('handles string endsWith scan', () => {
      const expr: FilterExpression = { fields: { name: { endsWith: 'top' } } }
      expect(resultSet(expr, ctx)).toEqual(new Set([0]))
    })
  })
})
