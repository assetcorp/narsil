import { describe, expect, it } from 'vitest'
import { applyAnd, applyNot, applyOr } from '../../filters/combinators'

describe('applyAnd', () => {
  it('returns empty set when given no sets', () => {
    expect(applyAnd([])).toEqual(new Set())
  })

  it('returns the single set when given one set', () => {
    const s = new Set([0, 1, 2])
    expect(applyAnd([s])).toBe(s)
  })

  it('intersects two overlapping sets', () => {
    const a = new Set([0, 1, 2])
    const b = new Set([1, 2, 3])
    expect(applyAnd([a, b])).toEqual(new Set([1, 2]))
  })

  it('returns empty set for disjoint sets', () => {
    const a = new Set([0, 1])
    const b = new Set([2, 3])
    expect(applyAnd([a, b])).toEqual(new Set())
  })

  it('intersects three sets', () => {
    const a = new Set([0, 1, 2, 3])
    const b = new Set([1, 2, 3, 4])
    const c = new Set([2, 3, 4, 5])
    expect(applyAnd([a, b, c])).toEqual(new Set([2, 3]))
  })

  it('starts with smallest set for efficiency', () => {
    const small = new Set([0])
    const large = new Set(Array.from({ length: 1000 }, (_, i) => i))
    const result = applyAnd([large, small])
    expect(result.size).toBeLessThanOrEqual(1)
  })

  it('short-circuits when intersection becomes empty', () => {
    const a = new Set([0])
    const b = new Set([1])
    const c = new Set([0, 1, 2])
    expect(applyAnd([a, b, c])).toEqual(new Set())
  })
})

describe('applyOr', () => {
  it('returns empty set when given no sets', () => {
    expect(applyOr([])).toEqual(new Set())
  })

  it('returns the single set when given one set', () => {
    const s = new Set([0, 1])
    expect(applyOr([s])).toBe(s)
  })

  it('unions two sets', () => {
    const a = new Set([0, 1])
    const b = new Set([1, 2])
    expect(applyOr([a, b])).toEqual(new Set([0, 1, 2]))
  })

  it('unions disjoint sets', () => {
    const a = new Set([0])
    const b = new Set([1])
    expect(applyOr([a, b])).toEqual(new Set([0, 1]))
  })

  it('unions identical sets without duplication', () => {
    const a = new Set([0, 1])
    const b = new Set([0, 1])
    expect(applyOr([a, b])).toEqual(new Set([0, 1]))
  })

  it('unions three sets', () => {
    const a = new Set([0])
    const b = new Set([1])
    const c = new Set([2])
    expect(applyOr([a, b, c])).toEqual(new Set([0, 1, 2]))
  })
})

describe('applyNot', () => {
  it('removes excluded items from universe', () => {
    const universe = new Set([0, 1, 2, 3])
    const excluded = new Set([1, 3])
    expect(applyNot(universe, excluded)).toEqual(new Set([0, 2]))
  })

  it('returns full universe when excluded set is empty', () => {
    const universe = new Set([0, 1])
    expect(applyNot(universe, new Set())).toEqual(new Set([0, 1]))
  })

  it('returns empty set when everything is excluded', () => {
    const universe = new Set([0, 1])
    expect(applyNot(universe, new Set([0, 1]))).toEqual(new Set())
  })

  it('ignores excluded items not in universe', () => {
    const universe = new Set([0, 1])
    const excluded = new Set([2, 3])
    expect(applyNot(universe, excluded)).toEqual(new Set([0, 1]))
  })

  it('handles empty universe', () => {
    expect(applyNot(new Set(), new Set([0]))).toEqual(new Set())
  })
})
