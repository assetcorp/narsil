import { describe, expect, it } from 'vitest'
import { defaultSortMode, isSortMode, toReducedSortValue } from '../../../core/ordering'

describe('toReducedSortValue', () => {
  it('takes the smallest value of a list under min and the largest under max', () => {
    expect(toReducedSortValue([25, 10, 40], 'min')).toBe(10)
    expect(toReducedSortValue([25, 10, 40], 'max')).toBe(40)
    expect(toReducedSortValue(['pear', 'Apple', 'fig'], 'min')).toBe('Apple')
    expect(toReducedSortValue(['pear', 'Apple', 'fig'], 'max')).toBe('pear')
  })

  it('orders mixed types the way the sort value order does, numbers first', () => {
    expect(toReducedSortValue([true, 'kiwi', 7], 'min')).toBe(7)
    expect(toReducedSortValue([true, 'kiwi', 7], 'max')).toBe(true)
  })

  it('takes the mean and the median of the numbers alone', () => {
    expect(toReducedSortValue([10, 20, 'n/a', 60], 'avg')).toBe(30)
    expect(toReducedSortValue([9, 1, 5], 'median')).toBe(5)
    expect(toReducedSortValue([1, 2, 3, 10], 'median')).toBe(2.5)
  })

  it('keeps a mean of the largest finite numbers finite', () => {
    expect(toReducedSortValue([Number.MAX_VALUE, Number.MAX_VALUE], 'avg')).toBe(Number.MAX_VALUE)
    expect(toReducedSortValue([Number.MAX_VALUE, Number.MAX_VALUE], 'median')).toBe(Number.MAX_VALUE)
  })

  it('reads an empty list, a list of nested lists, and a list without numbers as missing', () => {
    expect(toReducedSortValue([], 'min')).toBeNull()
    expect(toReducedSortValue([[1], { a: 2 }, null], 'max')).toBeNull()
    expect(toReducedSortValue(['a', Number.NaN, Number.POSITIVE_INFINITY], 'avg')).toBeNull()
  })

  it('leaves a single value as it is under every mode', () => {
    for (const mode of ['min', 'max', 'avg', 'median'] as const) {
      expect(toReducedSortValue(42, mode)).toBe(42)
      expect(toReducedSortValue('plum', mode)).toBe('plum')
      expect(toReducedSortValue(undefined, mode)).toBeNull()
    }
  })

  it('cuts a chosen string to the comparison window', () => {
    expect(toReducedSortValue(['z'.repeat(600)], 'min')).toHaveLength(512)
  })
})

describe('sort modes', () => {
  it('defaults to min ascending and max descending, and accepts only the four modes', () => {
    expect(defaultSortMode('asc')).toBe('min')
    expect(defaultSortMode('desc')).toBe('max')
    expect(isSortMode('median')).toBe(true)
    expect(isSortMode('sum')).toBe(false)
    expect(isSortMode(undefined)).toBe(false)
  })
})
