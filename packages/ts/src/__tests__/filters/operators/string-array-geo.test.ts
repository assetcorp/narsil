import { describe, expect, it } from 'vitest'
import type { GeoFieldIndex, GetFieldValue } from '../../../filters/operators'
import {
  applyContainsAll,
  applyEndsWith,
  applyExists,
  applyGeoPolygon,
  applyGeoRadius,
  applyIsEmpty,
  applyIsNotEmpty,
  applyMatchesAny,
  applyNotExists,
  applySize,
  applyStartsWith,
} from '../../../filters/operators'
import { allDocIds, getValue } from './fixtures'

describe('applyStartsWith / applyEndsWith', () => {
  it('applyStartsWith matches prefix', () => {
    expect(applyStartsWith('Al', allDocIds, getValue('name'))).toEqual(new Set([0]))
  })

  it('applyStartsWith returns empty when no match', () => {
    expect(applyStartsWith('Zzz', allDocIds, getValue('name'))).toEqual(new Set())
  })

  it('applyEndsWith matches suffix', () => {
    expect(applyEndsWith('lie', allDocIds, getValue('name'))).toEqual(new Set([2]))
  })

  it('skips non-string values', () => {
    expect(applyStartsWith('3', allDocIds, getValue('age'))).toEqual(new Set())
  })
})

describe('applyContainsAll / applyMatchesAny', () => {
  it('applyContainsAll returns docs containing all specified values', () => {
    expect(applyContainsAll(['a', 'b'], allDocIds, getValue('tags'))).toEqual(new Set([0]))
  })

  it('applyContainsAll returns empty when no doc has all values', () => {
    expect(applyContainsAll(['a', 'b', 'c'], allDocIds, getValue('tags'))).toEqual(new Set())
  })

  it('applyMatchesAny returns docs containing at least one value', () => {
    expect(applyMatchesAny(['a'], allDocIds, getValue('tags'))).toEqual(new Set([0, 2]))
  })

  it('applyMatchesAny returns empty when no match', () => {
    expect(applyMatchesAny(['z'], allDocIds, getValue('tags'))).toEqual(new Set())
  })

  it('skips non-array fields', () => {
    expect(applyContainsAll(['a'], allDocIds, getValue('name'))).toEqual(new Set())
  })
})

describe('applySize', () => {
  it('filters by exact array size', () => {
    expect(applySize({ eq: 2 }, allDocIds, getValue('tags'))).toEqual(new Set([0, 1]))
  })

  it('filters by gt size', () => {
    expect(applySize({ gt: 1 }, allDocIds, getValue('tags'))).toEqual(new Set([0, 1]))
  })

  it('filters by lte size', () => {
    expect(applySize({ lte: 1 }, allDocIds, getValue('tags'))).toEqual(new Set([2, 3]))
  })

  it('supports combined size conditions', () => {
    expect(applySize({ gte: 1, lte: 2 }, allDocIds, getValue('tags'))).toEqual(new Set([0, 1, 2]))
  })

  it('skips non-array fields', () => {
    expect(applySize({ eq: 5 }, allDocIds, getValue('name'))).toEqual(new Set())
  })
})

describe('applyExists / applyNotExists', () => {
  const sparse: Record<number, Record<string, unknown>> = {
    0: { score: 10 },
    1: {},
    2: { score: null },
    3: { score: 0 },
  }
  const ids = new Set([0, 1, 2, 3])
  const gv: GetFieldValue = id => sparse[id]?.score

  it('applyExists returns docs where field is defined and non-null', () => {
    expect(applyExists(ids, gv)).toEqual(new Set([0, 3]))
  })

  it('applyNotExists returns docs where field is undefined or null', () => {
    expect(applyNotExists(ids, gv)).toEqual(new Set([1, 2]))
  })
})

describe('applyIsEmpty / applyIsNotEmpty', () => {
  const data: Record<number, Record<string, unknown>> = {
    0: { val: '' },
    1: { val: 'hello' },
    2: { val: [] },
    3: { val: ['a'] },
    4: {},
    5: { val: null },
    6: { val: 0 },
    7: { val: false },
  }
  const ids = new Set([0, 1, 2, 3, 4, 5, 6, 7])
  const gv: GetFieldValue = id => data[id]?.val

  it('applyIsEmpty returns docs with empty/null/undefined values', () => {
    expect(applyIsEmpty(ids, gv)).toEqual(new Set([0, 2, 4, 5]))
  })

  it('applyIsNotEmpty returns docs with non-empty values', () => {
    expect(applyIsNotEmpty(ids, gv)).toEqual(new Set([1, 3, 6, 7]))
  })
})

describe('applyGeoRadius / applyGeoPolygon', () => {
  it('applyGeoRadius delegates to geo index with unit conversion', () => {
    let capturedArgs: unknown[] = []
    const geoIndex: GeoFieldIndex = {
      radiusQuery(lat, lon, dist, inside, hp) {
        capturedArgs = [lat, lon, dist, inside, hp]
        return new Set([0])
      },
      polygonQuery: () => new Set(),
    }
    const result = applyGeoRadius({ lat: 40, lon: -74, distance: 5, unit: 'km' }, geoIndex)
    expect(result).toEqual(new Set([0]))
    expect(capturedArgs).toEqual([40, -74, 5000, true, false])
  })

  it('applyGeoRadius passes inside and highPrecision flags', () => {
    let capturedArgs: unknown[] = []
    const geoIndex: GeoFieldIndex = {
      radiusQuery(lat, lon, dist, inside, hp) {
        capturedArgs = [lat, lon, dist, inside, hp]
        return new Set()
      },
      polygonQuery: () => new Set(),
    }
    applyGeoRadius({ lat: 0, lon: 0, distance: 1, unit: 'mi', inside: false, highPrecision: true }, geoIndex)
    expect(capturedArgs).toEqual([0, 0, 1609.344, false, true])
  })

  it('applyGeoPolygon delegates to geo index', () => {
    let capturedArgs: unknown[] = []
    const geoIndex: GeoFieldIndex = {
      radiusQuery: () => new Set(),
      polygonQuery(points, inside) {
        capturedArgs = [points, inside]
        return new Set([1])
      },
    }
    const points = [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 0 },
      { lat: 1, lon: 1 },
    ]
    const result = applyGeoPolygon({ points, inside: false }, geoIndex)
    expect(result).toEqual(new Set([1]))
    expect(capturedArgs).toEqual([points, false])
  })
})
