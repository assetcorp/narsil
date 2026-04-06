import { describe, expect, it } from 'vitest'
import { bitsetFromSet } from '../../core/bitset'
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

function createMockNumericIndex(entries: Array<{ value: number; docId: number }>): NumericFieldIndex {
  const toSet = (filter: (e: { value: number; docId: number }) => boolean) =>
    new Set(entries.filter(filter).map(e => e.docId))
  const toBitset = (filter: (e: { value: number; docId: number }) => boolean, cap: number) =>
    bitsetFromSet(toSet(filter), cap)
  return {
    eq: (v: number) => toSet(e => e.value === v),
    gt: (v: number) => toSet(e => e.value > v),
    gte: (v: number) => toSet(e => e.value >= v),
    lt: (v: number) => toSet(e => e.value < v),
    lte: (v: number) => toSet(e => e.value <= v),
    between: (min: number, max: number) => toSet(e => e.value >= min && e.value <= max),
    allDocIds: () => new Set(entries.map(e => e.docId)),
    eqBitset: (v: number, cap: number) => toBitset(e => e.value === v, cap),
    gtBitset: (v: number, cap: number) => toBitset(e => e.value > v, cap),
    gteBitset: (v: number, cap: number) => toBitset(e => e.value >= v, cap),
    ltBitset: (v: number, cap: number) => toBitset(e => e.value < v, cap),
    lteBitset: (v: number, cap: number) => toBitset(e => e.value <= v, cap),
    betweenBitset: (min: number, max: number, cap: number) => toBitset(e => e.value >= min && e.value <= max, cap),
    allDocIdsBitset: (cap: number) => bitsetFromSet(new Set(entries.map(e => e.docId)), cap),
  }
}

function createMockBooleanIndex(trueDocs: number[], falseDocs: number[]): BooleanFieldIndex {
  return {
    getTrue: () => new Set(trueDocs),
    getFalse: () => new Set(falseDocs),
    allDocIds: () => new Set([...trueDocs, ...falseDocs]),
    getTrueBitset: (cap: number) => bitsetFromSet(new Set(trueDocs), cap),
    getFalseBitset: (cap: number) => bitsetFromSet(new Set(falseDocs), cap),
    allDocIdsBitset: (cap: number) => bitsetFromSet(new Set([...trueDocs, ...falseDocs]), cap),
  }
}

function createMockEnumIndex(mapping: Record<string, number[]>): EnumFieldIndex {
  function allDocs(): Set<number> {
    const all = new Set<number>()
    for (const docIds of Object.values(mapping)) {
      for (const id of docIds) all.add(id)
    }
    return all
  }
  return {
    getDocIds: (value: string) => new Set(mapping[value] ?? []),
    allDocIds: allDocs,
    getDocIdsBitset: (value: string, cap: number) => bitsetFromSet(new Set(mapping[value] ?? []), cap),
    getDocIdsInBitset: (values: string[], cap: number) => {
      const combined = new Set<number>()
      for (const val of values) {
        for (const id of mapping[val] ?? []) combined.add(id)
      }
      return bitsetFromSet(combined, cap)
    },
    allDocIdsBitset: (cap: number) => bitsetFromSet(allDocs(), cap),
  }
}

const docs: Record<number, Record<string, unknown>> = {
  0: { name: 'Alice', age: 30, active: true, category: 'electronics', tags: ['a', 'b'], city: '' },
  1: { name: 'Bob', age: 25, active: false, category: 'books', tags: ['b', 'c'] },
  2: { name: 'Charlie', age: 35, active: true, category: 'electronics', tags: ['a'] },
  3: { name: 'Diana', age: 28, active: false, category: 'clothing', tags: [] },
}

const allDocIds = new Set([0, 1, 2, 3])

function getValue(field: string): GetFieldValue {
  return (id: number) => docs[id]?.[field]
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
    expect(applyEq(30, allDocIds, getValue('age'))).toEqual(new Set([0]))
  })

  it('matches strings by scanning', () => {
    expect(applyEq('Bob', allDocIds, getValue('name'))).toEqual(new Set([1]))
  })

  it('matches booleans by scanning', () => {
    expect(applyEq(true, allDocIds, getValue('active'))).toEqual(new Set([0, 2]))
  })

  it('returns empty set when no match', () => {
    expect(applyEq(999, allDocIds, getValue('age'))).toEqual(new Set())
  })

  it('uses numeric field index when available', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 30, docId: 0 },
        { value: 25, docId: 1 },
      ]),
    }
    expect(applyEq(30, allDocIds, getValue('age'), idx)).toEqual(new Set([0]))
  })

  it('uses boolean field index when available', () => {
    const idx: FieldIndex = {
      type: 'boolean',
      index: createMockBooleanIndex([0, 2], [1, 3]),
    }
    expect(applyEq(true, allDocIds, getValue('active'), idx)).toEqual(new Set([0, 2]))
    expect(applyEq(false, allDocIds, getValue('active'), idx)).toEqual(new Set([1, 3]))
  })

  it('uses enum field index when available', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: [0, 2], books: [1] }),
    }
    expect(applyEq('electronics', allDocIds, getValue('category'), idx)).toEqual(new Set([0, 2]))
  })

  it('falls back to scan when index type does not match value type', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([{ value: 30, docId: 0 }]),
    }
    expect(applyEq('Alice', allDocIds, getValue('name'), idx)).toEqual(new Set([0]))
  })
})

describe('applyNe', () => {
  it('excludes matching docs by scanning, skipping undefined/null fields', () => {
    const result = applyNe(30, allDocIds, getValue('age'))
    expect(result).toEqual(new Set([1, 2, 3]))
  })

  it('uses numeric index for ne', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 30, docId: 0 },
        { value: 25, docId: 1 },
        { value: 35, docId: 2 },
      ]),
    }
    expect(applyNe(30, allDocIds, getValue('age'), idx)).toEqual(new Set([1, 2]))
  })

  it('uses boolean index for ne', () => {
    const idx: FieldIndex = {
      type: 'boolean',
      index: createMockBooleanIndex([0, 2], [1, 3]),
    }
    expect(applyNe(true, allDocIds, getValue('active'), idx)).toEqual(new Set([1, 3]))
  })

  it('uses enum index for ne', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: [0, 2], books: [1], clothing: [3] }),
    }
    expect(applyNe('electronics', allDocIds, getValue('category'), idx)).toEqual(new Set([1, 3]))
  })

  it('skips docs with undefined field value during scan', () => {
    const sparseData: Record<number, Record<string, unknown>> = {
      0: { score: 10 },
      1: {},
      2: { score: 20 },
    }
    const ids = new Set([0, 1, 2])
    const gv: GetFieldValue = id => sparseData[id]?.score
    expect(applyNe(10, ids, gv)).toEqual(new Set([2]))
  })
})

describe('applyGt / applyLt / applyGte / applyLte', () => {
  it('applyGt filters by scanning', () => {
    expect(applyGt(28, allDocIds, getValue('age'))).toEqual(new Set([0, 2]))
  })

  it('applyLt filters by scanning', () => {
    expect(applyLt(30, allDocIds, getValue('age'))).toEqual(new Set([1, 3]))
  })

  it('applyGte includes boundary', () => {
    expect(applyGte(30, allDocIds, getValue('age'))).toEqual(new Set([0, 2]))
  })

  it('applyLte includes boundary', () => {
    expect(applyLte(28, allDocIds, getValue('age'))).toEqual(new Set([1, 3]))
  })

  it('applyGt uses numeric index', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 25, docId: 1 },
        { value: 30, docId: 0 },
        { value: 35, docId: 2 },
      ]),
    }
    expect(applyGt(28, allDocIds, getValue('age'), idx)).toEqual(new Set([0, 2]))
  })

  it('applyBetween filters inclusive range by scanning', () => {
    expect(applyBetween([26, 32], allDocIds, getValue('age'))).toEqual(new Set([0, 3]))
  })

  it('applyBetween uses numeric index', () => {
    const idx: FieldIndex = {
      type: 'numeric',
      index: createMockNumericIndex([
        { value: 25, docId: 1 },
        { value: 28, docId: 3 },
        { value: 30, docId: 0 },
        { value: 35, docId: 2 },
      ]),
    }
    expect(applyBetween([26, 32], allDocIds, getValue('age'), idx)).toEqual(new Set([3, 0]))
  })

  it('skips non-numeric values during scan', () => {
    const mixed: Record<number, Record<string, unknown>> = {
      0: { val: 10 },
      1: { val: 'hello' },
      2: { val: 20 },
    }
    const ids = new Set([0, 1, 2])
    const gv: GetFieldValue = id => mixed[id]?.val
    expect(applyGt(5, ids, gv)).toEqual(new Set([0, 2]))
  })
})

describe('applyIn / applyNin', () => {
  it('applyIn matches string values by scanning', () => {
    expect(applyIn(['Alice', 'Charlie'], allDocIds, getValue('name'))).toEqual(new Set([0, 2]))
  })

  it('applyIn uses enum index', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: [0, 2], books: [1] }),
    }
    expect(applyIn(['electronics', 'books'], allDocIds, getValue('category'), idx)).toEqual(new Set([0, 2, 1]))
  })

  it('applyNin excludes matching values by scanning', () => {
    expect(applyNin(['Alice', 'Charlie'], allDocIds, getValue('name'))).toEqual(new Set([1, 3]))
  })

  it('applyNin uses enum index', () => {
    const idx: FieldIndex = {
      type: 'enum',
      index: createMockEnumIndex({ electronics: [0, 2], books: [1], clothing: [3] }),
    }
    expect(applyNin(['electronics'], allDocIds, getValue('category'), idx)).toEqual(new Set([1, 3]))
  })

  it('applyNin skips docs with undefined fields during scan', () => {
    const sparse: Record<number, Record<string, unknown>> = {
      0: { color: 'red' },
      1: {},
      2: { color: 'blue' },
    }
    const ids = new Set([0, 1, 2])
    const gv: GetFieldValue = id => sparse[id]?.color
    expect(applyNin(['red'], ids, gv)).toEqual(new Set([2]))
  })
})

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
