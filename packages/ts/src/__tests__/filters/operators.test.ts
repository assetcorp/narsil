import { describe, expect, it } from 'vitest'
import type {
  BooleanFieldIndex,
  EnumFieldIndex,
  FieldIndex,
  GeoFieldIndex,
  GetFieldValue,
  NumericFieldIndex,
} from '../../filters/operators'
import {
  applyBetween,
  applyContainsAll,
  applyEndsWith,
  applyEq,
  applyExists,
  applyGeoPolygon,
  applyGeoRadius,
  applyGt,
  applyGte,
  applyIn,
  applyIsEmpty,
  applyIsNotEmpty,
  applyLt,
  applyLte,
  applyMatchesAny,
  applyNe,
  applyNin,
  applyNotExists,
  applySize,
  applyStartsWith,
  convertToMeters,
} from '../../filters/operators'

function createMockNumericIndex(entries: Array<{ value: number; docId: string }>): NumericFieldIndex {
  return {
    eq(value: number) {
      return new Set(entries.filter(e => e.value === value).map(e => e.docId))
    },
    gt(value: number) {
      return new Set(entries.filter(e => e.value > value).map(e => e.docId))
    },
    gte(value: number) {
      return new Set(entries.filter(e => e.value >= value).map(e => e.docId))
    },
    lt(value: number) {
      return new Set(entries.filter(e => e.value < value).map(e => e.docId))
    },
    lte(value: number) {
      return new Set(entries.filter(e => e.value <= value).map(e => e.docId))
    },
    between(min: number, max: number) {
      return new Set(entries.filter(e => e.value >= min && e.value <= max).map(e => e.docId))
    },
    allDocIds() {
      return new Set(entries.map(e => e.docId))
    },
  }
}

function createMockBooleanIndex(trueDocs: string[], falseDocs: string[]): BooleanFieldIndex {
  return {
    getTrue: () => new Set(trueDocs),
    getFalse: () => new Set(falseDocs),
    allDocIds: () => new Set([...trueDocs, ...falseDocs]),
  }
}

function createMockEnumIndex(mapping: Record<string, string[]>): EnumFieldIndex {
  return {
    getDocIds(value: string) {
      return new Set(mapping[value] ?? [])
    },
    allDocIds() {
      const all = new Set<string>()
      for (const docIds of Object.values(mapping)) {
        for (const id of docIds) all.add(id)
      }
      return all
    },
  }
}

const docs: Record<string, Record<string, unknown>> = {
  doc1: { name: 'Alice', age: 30, active: true, category: 'electronics', tags: ['a', 'b'], city: '' },
  doc2: { name: 'Bob', age: 25, active: false, category: 'books', tags: ['b', 'c'] },
  doc3: { name: 'Charlie', age: 35, active: true, category: 'electronics', tags: ['a'] },
  doc4: { name: 'Diana', age: 28, active: false, category: 'clothing', tags: [] },
}

const allDocIds = new Set(Object.keys(docs))

function getValue(field: string): GetFieldValue {
  return (docId: string) => docs[docId]?.[field]
}

describe('convertToMeters', () => {
  it('converts kilometers to meters', () => {
    expect(convertToMeters(5, 'km')).toBe(5000)
  })
  it('converts miles to meters', () => {
    expect(convertToMeters(1, 'mi')).toBeCloseTo(1609.344)
  })
  it('passes meters through', () => {
    expect(convertToMeters(500, 'm')).toBe(500)
  })
})

describe('applyEq', () => {
  it('matches by scanning document values', () => {
    expect(applyEq(30, allDocIds, getValue('age'))).toEqual(new Set(['doc1']))
  })

  it('matches strings by scanning', () => {
    expect(applyEq('Bob', allDocIds, getValue('name'))).toEqual(new Set(['doc2']))
  })

  it('matches booleans by scanning', () => {
    expect(applyEq(true, allDocIds, getValue('active'))).toEqual(new Set(['doc1', 'doc3']))
  })

  it('returns empty set when no match', () => {
    expect(applyEq(999, allDocIds, getValue('age'))).toEqual(new Set())
  })

  it('uses numeric field index when available', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 30, docId: 'doc1' },
        { value: 25, docId: 'doc2' },
      ]),
    }
    expect(applyEq(30, allDocIds, getValue('age'), idx)).toEqual(new Set(['doc1']))
  })

  it('uses boolean field index when available', () => {
    const idx: FieldIndex = {
      type: 'boolean',
      index: createMockBooleanIndex(['doc1', 'doc3'], ['doc2', 'doc4']),
    }
    expect(applyEq(true, allDocIds, getValue('active'), idx)).toEqual(new Set(['doc1', 'doc3']))
    expect(applyEq(false, allDocIds, getValue('active'), idx)).toEqual(new Set(['doc2', 'doc4']))
  })

  it('uses enum field index when available', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: ['doc1', 'doc3'], books: ['doc2'] }),
    }
    expect(applyEq('electronics', allDocIds, getValue('category'), idx)).toEqual(new Set(['doc1', 'doc3']))
  })

  it('falls back to scan when index type does not match value type', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([{ value: 30, docId: 'doc1' }]),
    }
    expect(applyEq('Alice', allDocIds, getValue('name'), idx)).toEqual(new Set(['doc1']))
  })
})

describe('applyNe', () => {
  it('excludes matching docs by scanning, skipping undefined/null fields', () => {
    const result = applyNe(30, allDocIds, getValue('age'))
    expect(result).toEqual(new Set(['doc2', 'doc3', 'doc4']))
  })

  it('uses numeric index for ne', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 30, docId: 'doc1' },
        { value: 25, docId: 'doc2' },
        { value: 35, docId: 'doc3' },
      ]),
    }
    expect(applyNe(30, allDocIds, getValue('age'), idx)).toEqual(new Set(['doc2', 'doc3']))
  })

  it('uses boolean index for ne', () => {
    const idx: FieldIndex = {
      type: 'boolean',
      index: createMockBooleanIndex(['doc1', 'doc3'], ['doc2', 'doc4']),
    }
    expect(applyNe(true, allDocIds, getValue('active'), idx)).toEqual(new Set(['doc2', 'doc4']))
  })

  it('uses enum index for ne', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: ['doc1', 'doc3'], books: ['doc2'], clothing: ['doc4'] }),
    }
    expect(applyNe('electronics', allDocIds, getValue('category'), idx)).toEqual(new Set(['doc2', 'doc4']))
  })

  it('skips docs with undefined field value during scan', () => {
    const sparseData: Record<string, Record<string, unknown>> = {
      d1: { score: 10 },
      d2: {},
      d3: { score: 20 },
    }
    const ids = new Set(Object.keys(sparseData))
    const gv: GetFieldValue = id => sparseData[id]?.score
    expect(applyNe(10, ids, gv)).toEqual(new Set(['d3']))
  })
})

describe('applyGt / applyLt / applyGte / applyLte', () => {
  it('applyGt filters by scanning', () => {
    expect(applyGt(28, allDocIds, getValue('age'))).toEqual(new Set(['doc1', 'doc3']))
  })

  it('applyLt filters by scanning', () => {
    expect(applyLt(30, allDocIds, getValue('age'))).toEqual(new Set(['doc2', 'doc4']))
  })

  it('applyGte includes boundary', () => {
    expect(applyGte(30, allDocIds, getValue('age'))).toEqual(new Set(['doc1', 'doc3']))
  })

  it('applyLte includes boundary', () => {
    expect(applyLte(28, allDocIds, getValue('age'))).toEqual(new Set(['doc2', 'doc4']))
  })

  it('applyGt uses numeric index', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 25, docId: 'doc2' },
        { value: 30, docId: 'doc1' },
        { value: 35, docId: 'doc3' },
      ]),
    }
    expect(applyGt(28, allDocIds, getValue('age'), idx)).toEqual(new Set(['doc1', 'doc3']))
  })

  it('applyBetween filters inclusive range by scanning', () => {
    expect(applyBetween([26, 32], allDocIds, getValue('age'))).toEqual(new Set(['doc1', 'doc4']))
  })

  it('applyBetween uses numeric index', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 25, docId: 'doc2' },
        { value: 28, docId: 'doc4' },
        { value: 30, docId: 'doc1' },
        { value: 35, docId: 'doc3' },
      ]),
    }
    expect(applyBetween([26, 32], allDocIds, getValue('age'), idx)).toEqual(new Set(['doc4', 'doc1']))
  })

  it('skips non-numeric values during scan', () => {
    const mixed: Record<string, Record<string, unknown>> = {
      d1: { val: 10 },
      d2: { val: 'hello' },
      d3: { val: 20 },
    }
    const ids = new Set(Object.keys(mixed))
    const gv: GetFieldValue = id => mixed[id]?.val
    expect(applyGt(5, ids, gv)).toEqual(new Set(['d1', 'd3']))
  })
})

describe('applyIn / applyNin', () => {
  it('applyIn matches string values by scanning', () => {
    expect(applyIn(['Alice', 'Charlie'], allDocIds, getValue('name'))).toEqual(new Set(['doc1', 'doc3']))
  })

  it('applyIn uses enum index', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: ['doc1', 'doc3'], books: ['doc2'] }),
    }
    expect(applyIn(['electronics', 'books'], allDocIds, getValue('category'), idx)).toEqual(
      new Set(['doc1', 'doc3', 'doc2']),
    )
  })

  it('applyNin excludes matching values by scanning', () => {
    expect(applyNin(['Alice', 'Charlie'], allDocIds, getValue('name'))).toEqual(new Set(['doc2', 'doc4']))
  })

  it('applyNin uses enum index', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: ['doc1', 'doc3'], books: ['doc2'], clothing: ['doc4'] }),
    }
    expect(applyNin(['electronics'], allDocIds, getValue('category'), idx)).toEqual(new Set(['doc2', 'doc4']))
  })

  it('applyNin skips docs with undefined fields during scan', () => {
    const sparse: Record<string, Record<string, unknown>> = {
      d1: { color: 'red' },
      d2: {},
      d3: { color: 'blue' },
    }
    const ids = new Set(Object.keys(sparse))
    const gv: GetFieldValue = id => sparse[id]?.color
    expect(applyNin(['red'], ids, gv)).toEqual(new Set(['d3']))
  })
})

describe('applyStartsWith / applyEndsWith', () => {
  it('applyStartsWith matches prefix', () => {
    expect(applyStartsWith('Al', allDocIds, getValue('name'))).toEqual(new Set(['doc1']))
  })

  it('applyStartsWith returns empty when no match', () => {
    expect(applyStartsWith('Zzz', allDocIds, getValue('name'))).toEqual(new Set())
  })

  it('applyEndsWith matches suffix', () => {
    expect(applyEndsWith('lie', allDocIds, getValue('name'))).toEqual(new Set(['doc3']))
  })

  it('skips non-string values', () => {
    expect(applyStartsWith('3', allDocIds, getValue('age'))).toEqual(new Set())
  })
})

describe('applyContainsAll / applyMatchesAny', () => {
  it('applyContainsAll returns docs containing all specified values', () => {
    expect(applyContainsAll(['a', 'b'], allDocIds, getValue('tags'))).toEqual(new Set(['doc1']))
  })

  it('applyContainsAll returns empty when no doc has all values', () => {
    expect(applyContainsAll(['a', 'b', 'c'], allDocIds, getValue('tags'))).toEqual(new Set())
  })

  it('applyMatchesAny returns docs containing at least one value', () => {
    expect(applyMatchesAny(['a'], allDocIds, getValue('tags'))).toEqual(new Set(['doc1', 'doc3']))
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
    expect(applySize({ eq: 2 }, allDocIds, getValue('tags'))).toEqual(new Set(['doc1', 'doc2']))
  })

  it('filters by gt size', () => {
    expect(applySize({ gt: 1 }, allDocIds, getValue('tags'))).toEqual(new Set(['doc1', 'doc2']))
  })

  it('filters by lte size', () => {
    expect(applySize({ lte: 1 }, allDocIds, getValue('tags'))).toEqual(new Set(['doc3', 'doc4']))
  })

  it('supports combined size conditions', () => {
    expect(applySize({ gte: 1, lte: 2 }, allDocIds, getValue('tags'))).toEqual(new Set(['doc1', 'doc2', 'doc3']))
  })

  it('skips non-array fields', () => {
    expect(applySize({ eq: 5 }, allDocIds, getValue('name'))).toEqual(new Set())
  })
})

describe('applyExists / applyNotExists', () => {
  const sparse: Record<string, Record<string, unknown>> = {
    d1: { score: 10 },
    d2: {},
    d3: { score: null },
    d4: { score: 0 },
  }
  const ids = new Set(Object.keys(sparse))
  const gv: GetFieldValue = id => sparse[id]?.score

  it('applyExists returns docs where field is defined and non-null', () => {
    expect(applyExists(ids, gv)).toEqual(new Set(['d1', 'd4']))
  })

  it('applyNotExists returns docs where field is undefined or null', () => {
    expect(applyNotExists(ids, gv)).toEqual(new Set(['d2', 'd3']))
  })
})

describe('applyIsEmpty / applyIsNotEmpty', () => {
  const data: Record<string, Record<string, unknown>> = {
    d1: { val: '' },
    d2: { val: 'hello' },
    d3: { val: [] },
    d4: { val: ['a'] },
    d5: {},
    d6: { val: null },
    d7: { val: 0 },
    d8: { val: false },
  }
  const ids = new Set(Object.keys(data))
  const gv: GetFieldValue = id => data[id]?.val

  it('applyIsEmpty returns docs with empty/null/undefined values', () => {
    expect(applyIsEmpty(ids, gv)).toEqual(new Set(['d1', 'd3', 'd5', 'd6']))
  })

  it('applyIsNotEmpty returns docs with non-empty values', () => {
    expect(applyIsNotEmpty(ids, gv)).toEqual(new Set(['d2', 'd4', 'd7', 'd8']))
  })
})

describe('applyGeoRadius / applyGeoPolygon', () => {
  it('applyGeoRadius delegates to geo index with unit conversion', () => {
    let capturedArgs: unknown[] = []
    const geoIndex: GeoFieldIndex = {
      radiusQuery(lat, lon, dist, inside, hp) {
        capturedArgs = [lat, lon, dist, inside, hp]
        return new Set(['doc1'])
      },
      polygonQuery: () => new Set(),
    }
    const result = applyGeoRadius({ lat: 40, lon: -74, distance: 5, unit: 'km' }, geoIndex)
    expect(result).toEqual(new Set(['doc1']))
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
        return new Set(['doc2'])
      },
    }
    const points = [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 0 },
      { lat: 1, lon: 1 },
    ]
    const result = applyGeoPolygon({ points, inside: false }, geoIndex)
    expect(result).toEqual(new Set(['doc2']))
    expect(capturedArgs).toEqual([points, false])
  })
})
