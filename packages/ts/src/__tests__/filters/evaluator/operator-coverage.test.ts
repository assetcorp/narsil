import { describe, expect, it } from 'vitest'
import type { FilterContext } from '../../../filters/evaluator'
import { FIELD_FILTER_OPERATORS } from '../../../filters/keys'
import type { GeoFieldIndex } from '../../../filters/operators'
import type { FieldFilter } from '../../../types/filters'
import { buildContext, resultSet } from './fixtures'

type OperatorProbe = { field: string; filter: FieldFilter }

const probes: Record<(typeof FIELD_FILTER_OPERATORS)[number], OperatorProbe> = {
  eq: { field: 'price', filter: { eq: 999 } },
  ne: { field: 'price', filter: { ne: 15 } },
  gt: { field: 'price', filter: { gt: 100 } },
  lt: { field: 'price', filter: { lt: 100 } },
  gte: { field: 'price', filter: { gte: 199 } },
  lte: { field: 'price', filter: { lte: 25 } },
  between: { field: 'price', filter: { between: [20, 40] } },
  in: { field: 'category', filter: { in: ['books'] } },
  nin: { field: 'category', filter: { nin: ['books'] } },
  startsWith: { field: 'name', filter: { startsWith: 'Head' } },
  endsWith: { field: 'name', filter: { endsWith: 'book' } },
  containsAll: { field: 'tags', filter: { containsAll: ['tech'] } },
  matchesAny: { field: 'tags', filter: { matchesAny: ['fiction'] } },
  size: { field: 'tags', filter: { size: { eq: 0 } } },
  exists: { field: 'discontinuedAt', filter: { exists: true } },
  notExists: { field: 'name', filter: { notExists: true } },
  isEmpty: { field: 'tags', filter: { isEmpty: true } },
  isNotEmpty: { field: 'tags', filter: { isNotEmpty: true } },
  radius: { field: 'location', filter: { radius: { lat: 40.7, lon: -74.0, distance: 10, unit: 'km' } } },
  polygon: {
    field: 'location',
    filter: {
      polygon: {
        points: [
          { lat: 40, lon: -75 },
          { lat: 41, lon: -75 },
          { lat: 41, lon: -73 },
        ],
      },
    },
  },
}

function buildContextWithGeo(): FilterContext {
  const base = buildContext()
  return {
    ...base,
    fieldIndexes: {
      ...base.fieldIndexes,
      location: {
        type: 'geopoint',
        index: {
          radiusQuery: () => new Set([0]),
          polygonQuery: () => new Set([1]),
        } as GeoFieldIndex,
      },
    },
  }
}

describe('every advertised filter operator constrains the result', () => {
  const ctx = buildContextWithGeo()

  it('probes exactly the advertised operator list', () => {
    expect(Object.keys(probes).sort()).toEqual([...FIELD_FILTER_OPERATORS].sort())
  })

  for (const operator of FIELD_FILTER_OPERATORS) {
    it(`applies ${operator} instead of silently ignoring it`, () => {
      const probe = probes[operator]
      const result = resultSet({ fields: { [probe.field]: probe.filter } }, ctx)
      expect(result).not.toEqual(ctx.allDocIds)
    })
  }
})
