import { describe, expect, it } from 'vitest'
import {
  addToOrdinalFilter,
  createOrdinalFilter,
  type OrdinalFilter,
  ordinalFilterHas,
  ordinalFilterValues,
} from '../../vector/ordinal-filter'

function values(filter: OrdinalFilter): number[] {
  return Array.from(ordinalFilterValues(filter))
}

describe('ordinal filter', () => {
  it('starts empty with one bit per slot rounded up to whole bytes', () => {
    expect(createOrdinalFilter(0).bits).toHaveLength(0)
    expect(createOrdinalFilter(1).bits).toHaveLength(1)
    expect(createOrdinalFilter(8).bits).toHaveLength(1)
    expect(createOrdinalFilter(9).bits).toHaveLength(2)
    expect(createOrdinalFilter(9).count).toBe(0)
  })

  it('holds an ordinal after it is added and counts it once', () => {
    const filter = createOrdinalFilter(64)
    addToOrdinalFilter(filter, 0)
    addToOrdinalFilter(filter, 7)
    addToOrdinalFilter(filter, 8)
    addToOrdinalFilter(filter, 63)
    addToOrdinalFilter(filter, 7)

    expect(filter.count).toBe(4)
    expect(ordinalFilterHas(filter, 0)).toBe(true)
    expect(ordinalFilterHas(filter, 7)).toBe(true)
    expect(ordinalFilterHas(filter, 8)).toBe(true)
    expect(ordinalFilterHas(filter, 63)).toBe(true)
    expect(ordinalFilterHas(filter, 1)).toBe(false)
    expect(ordinalFilterHas(filter, 62)).toBe(false)
  })

  it('ignores an ordinal beyond the slots it was created over', () => {
    const filter = createOrdinalFilter(8)
    addToOrdinalFilter(filter, 8)
    addToOrdinalFilter(filter, 200)

    expect(filter.count).toBe(0)
    expect(ordinalFilterHas(filter, 8)).toBe(false)
    expect(ordinalFilterHas(filter, 200)).toBe(false)
  })

  it('yields set ordinals in ascending order', () => {
    const filter = createOrdinalFilter(40)
    for (const ordinal of [33, 2, 15, 8, 0]) {
      addToOrdinalFilter(filter, ordinal)
    }

    expect(values(filter)).toEqual([0, 2, 8, 15, 33])
    expect(values(createOrdinalFilter(40))).toEqual([])
  })
})
