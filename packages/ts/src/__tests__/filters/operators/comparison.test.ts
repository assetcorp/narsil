import { describe, expect, it } from 'vitest'
import type { FieldIndex, GetFieldValue } from '../../../filters/operators'
import {
  applyBetween,
  applyEq,
  applyGt,
  applyGte,
  applyIn,
  applyLt,
  applyLte,
  applyNe,
  applyNin,
  convertToMeters,
} from '../../../filters/operators'
import { allDocIds, createMockBooleanIndex, createMockEnumIndex, createMockNumericIndex, getValue } from './fixtures'

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
