import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { FilterContext } from '../../filters/evaluator'
import { evaluateFilters } from '../../filters/evaluator'
import type { FieldIndex, GeoFieldIndex } from '../../filters/operators'
import type { FilterExpression } from '../../types/filters'

const products: Record<number, Record<string, unknown>> = {
  0: { name: 'Laptop', price: 999, category: 'electronics', inStock: true, tags: ['tech', 'portable'] },
  1: { name: 'Novel', price: 15, category: 'books', inStock: true, tags: ['fiction'] },
  2: { name: 'T-Shirt', price: 25, category: 'clothing', inStock: false, tags: ['apparel', 'cotton'] },
  3: { name: 'Headphones', price: 199, category: 'electronics', inStock: true, tags: ['tech', 'audio'] },
  4: { name: 'Cookbook', price: 30, category: 'books', inStock: false, tags: [] },
}

function makeNumericFieldIndex(field: string): FieldIndex {
  const entries = Object.entries(products)
    .filter(([, doc]) => typeof doc[field] === 'number')
    .map(([id, doc]) => ({ value: doc[field] as number, docId: Number(id) }))
  return {
    type: 'numeric',
    index: {
      eq: (v: number) => new Set(entries.filter(e => e.value === v).map(e => e.docId)),
      gt: (v: number) => new Set(entries.filter(e => e.value > v).map(e => e.docId)),
      gte: (v: number) => new Set(entries.filter(e => e.value >= v).map(e => e.docId)),
      lt: (v: number) => new Set(entries.filter(e => e.value < v).map(e => e.docId)),
      lte: (v: number) => new Set(entries.filter(e => e.value <= v).map(e => e.docId)),
      between: (min: number, max: number) =>
        new Set(entries.filter(e => e.value >= min && e.value <= max).map(e => e.docId)),
      allDocIds: () => new Set(entries.map(e => e.docId)),
    },
  }
}

function makeBooleanFieldIndex(field: string): FieldIndex {
  const trueDocs: number[] = []
  const falseDocs: number[] = []
  for (const [id, doc] of Object.entries(products)) {
    if (doc[field] === true) trueDocs.push(Number(id))
    else if (doc[field] === false) falseDocs.push(Number(id))
  }
  return {
    type: 'boolean',
    index: {
      getTrue: () => new Set(trueDocs),
      getFalse: () => new Set(falseDocs),
      allDocIds: () => new Set([...trueDocs, ...falseDocs]),
    },
  }
}

function makeEnumFieldIndex(field: string): FieldIndex {
  const mapping: Record<string, number[]> = {}
  for (const [id, doc] of Object.entries(products)) {
    const val = doc[field]
    if (typeof val === 'string') {
      if (!mapping[val]) mapping[val] = []
      mapping[val].push(Number(id))
    }
  }
  return {
    type: 'enum',
    index: {
      getDocIds: (v: string) => new Set(mapping[v] ?? []),
      allDocIds: () => {
        const all = new Set<number>()
        for (const ids of Object.values(mapping)) {
          for (const id of ids) all.add(id)
        }
        return all
      },
    },
  }
}

function buildContext(): FilterContext {
  return {
    fieldIndexes: {
      price: makeNumericFieldIndex('price'),
      inStock: makeBooleanFieldIndex('inStock'),
      category: makeEnumFieldIndex('category'),
    },
    getFieldValue: (id, fieldPath) => products[id]?.[fieldPath],
    allDocIds: new Set([0, 1, 2, 3, 4]),
  }
}

describe('evaluateFilters', () => {
  const ctx = buildContext()

  it('returns all doc IDs for an empty expression', () => {
    expect(evaluateFilters({}, ctx)).toEqual(ctx.allDocIds)
  })

  describe('single field filters', () => {
    it('filters by numeric eq using index', () => {
      const expr: FilterExpression = { fields: { price: { eq: 999 } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0]))
    })

    it('filters by numeric range using index', () => {
      const expr: FilterExpression = { fields: { price: { gt: 100 } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 3]))
    })

    it('filters by boolean using index', () => {
      const expr: FilterExpression = { fields: { inStock: { eq: true } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('filters by enum using index', () => {
      const expr: FilterExpression = { fields: { category: { eq: 'books' } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1, 4]))
    })

    it('filters by string scan (no index for name)', () => {
      const expr: FilterExpression = { fields: { name: { startsWith: 'Head' } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([3]))
    })

    it('filters by array containsAll', () => {
      const expr: FilterExpression = { fields: { tags: { containsAll: ['tech', 'audio'] } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([3]))
    })

    it('filters by array matchesAny', () => {
      const expr: FilterExpression = { fields: { tags: { matchesAny: ['fiction', 'cotton'] } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1, 2]))
    })

    it('filters by array size', () => {
      const expr: FilterExpression = { fields: { tags: { size: { eq: 0 } } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([4]))
    })
  })

  describe('multiple operators on one field (AND logic)', () => {
    it('combines gt and lt for a range', () => {
      const expr: FilterExpression = { fields: { price: { gt: 20, lt: 200 } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([2, 3, 4]))
    })

    it('combines gte and lte', () => {
      const expr: FilterExpression = { fields: { price: { gte: 25, lte: 199 } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([2, 3, 4]))
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
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([3]))
    })
  })

  describe('logical combinators', () => {
    it('evaluates AND combinator', () => {
      const expr: FilterExpression = {
        and: [{ fields: { inStock: { eq: true } } }, { fields: { price: { lt: 50 } } }],
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1]))
    })

    it('evaluates OR combinator', () => {
      const expr: FilterExpression = {
        or: [{ fields: { category: { eq: 'electronics' } } }, { fields: { category: { eq: 'books' } } }],
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 1, 3, 4]))
    })

    it('evaluates NOT combinator', () => {
      const expr: FilterExpression = {
        not: { fields: { inStock: { eq: false } } },
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('combines fields with OR', () => {
      const expr: FilterExpression = {
        fields: { price: { gt: 100 } },
        or: [{ fields: { category: { eq: 'books' } } }, { fields: { category: { eq: 'clothing' } } }],
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set())
    })

    it('combines fields with NOT', () => {
      const expr: FilterExpression = {
        fields: { inStock: { eq: true } },
        not: { fields: { category: { eq: 'electronics' } } },
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1]))
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
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 1, 3]))
    })

    it('handles not inside and', () => {
      const expr: FilterExpression = {
        and: [{ fields: { inStock: { eq: true } } }, { not: { fields: { price: { gt: 500 } } } }],
      }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1, 3]))
    })
  })

  describe('presence filters', () => {
    const sparseProducts: Record<number, Record<string, unknown>> = {
      0: { name: 'A', rating: 4.5 },
      1: { name: 'B' },
      2: { name: 'C', rating: null },
      3: { name: 'D', rating: 3.0 },
    }
    const sparseCtx: FilterContext = {
      fieldIndexes: {},
      getFieldValue: (id, field) => sparseProducts[id]?.[field],
      allDocIds: new Set([0, 1, 2, 3]),
    }

    it('filters by exists: true', () => {
      const expr: FilterExpression = { fields: { rating: { exists: true } } }
      expect(evaluateFilters(expr, sparseCtx)).toEqual(new Set([0, 3]))
    })

    it('filters by exists: false', () => {
      const expr: FilterExpression = { fields: { rating: { exists: false } } }
      expect(evaluateFilters(expr, sparseCtx)).toEqual(new Set([1, 2]))
    })

    it('filters by notExists: true', () => {
      const expr: FilterExpression = { fields: { rating: { notExists: true } } }
      expect(evaluateFilters(expr, sparseCtx)).toEqual(new Set([1, 2]))
    })
  })

  describe('isEmpty / isNotEmpty', () => {
    const dataProducts: Record<number, Record<string, unknown>> = {
      0: { label: 'hello', items: ['x'] },
      1: { label: '', items: [] },
      2: { items: ['a', 'b'] },
    }
    const emptyCtx: FilterContext = {
      fieldIndexes: {},
      getFieldValue: (id, field) => dataProducts[id]?.[field],
      allDocIds: new Set([0, 1, 2]),
    }

    it('isEmpty: true matches empty strings, empty arrays, and missing fields', () => {
      const expr: FilterExpression = { fields: { label: { isEmpty: true } } }
      expect(evaluateFilters(expr, emptyCtx)).toEqual(new Set([1, 2]))
    })

    it('isNotEmpty: true matches non-empty values', () => {
      const expr: FilterExpression = { fields: { label: { isNotEmpty: true } } }
      expect(evaluateFilters(expr, emptyCtx)).toEqual(new Set([0]))
    })
  })

  describe('enum in/nin operators', () => {
    it('filters by in using enum index', () => {
      const expr: FilterExpression = { fields: { category: { in: ['electronics', 'clothing'] } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0, 2, 3]))
    })

    it('filters by nin using enum index', () => {
      const expr: FilterExpression = { fields: { category: { nin: ['electronics'] } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1, 2, 4]))
    })
  })

  describe('between operator', () => {
    it('filters by between range using numeric index', () => {
      const expr: FilterExpression = { fields: { price: { between: [20, 100] } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([2, 4]))
    })
  })

  describe('ne operator', () => {
    it('filters by ne using numeric index', () => {
      const expr: FilterExpression = { fields: { price: { ne: 999 } } }
      const result = evaluateFilters(expr, ctx)
      expect(result.has(0)).toBe(false)
      expect(result.size).toBe(4)
    })

    it('filters by ne on enum using index', () => {
      const expr: FilterExpression = { fields: { category: { ne: 'electronics' } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([1, 2, 4]))
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
        allDocIds: new Set([0, 1, 2, 3]),
      }
      const expr: FilterExpression = {
        fields: { location: { radius: { lat: 40.7, lon: -74.0, distance: 10, unit: 'km' } } },
      }
      expect(evaluateFilters(expr, geoCtx)).toEqual(new Set([0, 3]))
    })

    it('evaluates geo polygon filter with geopoint index', () => {
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
        allDocIds: new Set([0, 1, 2]),
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
      expect(evaluateFilters(expr, geoCtx)).toEqual(new Set([1]))
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
      expect(evaluateFilters(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('ignores empty or array', () => {
      const expr: FilterExpression = { or: [] }
      expect(evaluateFilters(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('handles field filter with no recognized operators as match-all', () => {
      const expr: FilterExpression = { fields: { price: {} } }
      expect(evaluateFilters(expr, ctx)).toEqual(ctx.allDocIds)
    })

    it('handles string endsWith scan', () => {
      const expr: FilterExpression = { fields: { name: { endsWith: 'top' } } }
      expect(evaluateFilters(expr, ctx)).toEqual(new Set([0]))
    })
  })
})
