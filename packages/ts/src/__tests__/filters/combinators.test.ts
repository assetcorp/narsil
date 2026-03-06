import { describe, expect, it } from 'vitest'
import { applyAnd, applyNot, applyOr } from '../../filters/combinators'

describe('applyAnd', () => {
  it('returns empty set when given no sets', () => {
    expect(applyAnd([])).toEqual(new Set())
  })

  it('returns the single set when given one set', () => {
    const s = new Set(['a', 'b', 'c'])
    expect(applyAnd([s])).toBe(s)
  })

  it('intersects two overlapping sets', () => {
    const a = new Set(['doc1', 'doc2', 'doc3'])
    const b = new Set(['doc2', 'doc3', 'doc4'])
    expect(applyAnd([a, b])).toEqual(new Set(['doc2', 'doc3']))
  })

  it('returns empty set for disjoint sets', () => {
    const a = new Set(['doc1', 'doc2'])
    const b = new Set(['doc3', 'doc4'])
    expect(applyAnd([a, b])).toEqual(new Set())
  })

  it('intersects three sets', () => {
    const a = new Set(['doc1', 'doc2', 'doc3', 'doc4'])
    const b = new Set(['doc2', 'doc3', 'doc4', 'doc5'])
    const c = new Set(['doc3', 'doc4', 'doc5', 'doc6'])
    expect(applyAnd([a, b, c])).toEqual(new Set(['doc3', 'doc4']))
  })

  it('starts with smallest set for efficiency', () => {
    const small = new Set(['doc1'])
    const large = new Set(Array.from({ length: 1000 }, (_, i) => `doc${i}`))
    const result = applyAnd([large, small])
    expect(result.size).toBeLessThanOrEqual(1)
  })

  it('short-circuits when intersection becomes empty', () => {
    const a = new Set(['doc1'])
    const b = new Set(['doc2'])
    const c = new Set(['doc1', 'doc2', 'doc3'])
    expect(applyAnd([a, b, c])).toEqual(new Set())
  })
})

describe('applyOr', () => {
  it('returns empty set when given no sets', () => {
    expect(applyOr([])).toEqual(new Set())
  })

  it('returns the single set when given one set', () => {
    const s = new Set(['a', 'b'])
    expect(applyOr([s])).toBe(s)
  })

  it('unions two sets', () => {
    const a = new Set(['doc1', 'doc2'])
    const b = new Set(['doc2', 'doc3'])
    expect(applyOr([a, b])).toEqual(new Set(['doc1', 'doc2', 'doc3']))
  })

  it('unions disjoint sets', () => {
    const a = new Set(['doc1'])
    const b = new Set(['doc2'])
    expect(applyOr([a, b])).toEqual(new Set(['doc1', 'doc2']))
  })

  it('unions identical sets without duplication', () => {
    const a = new Set(['doc1', 'doc2'])
    const b = new Set(['doc1', 'doc2'])
    expect(applyOr([a, b])).toEqual(new Set(['doc1', 'doc2']))
  })

  it('unions three sets', () => {
    const a = new Set(['doc1'])
    const b = new Set(['doc2'])
    const c = new Set(['doc3'])
    expect(applyOr([a, b, c])).toEqual(new Set(['doc1', 'doc2', 'doc3']))
  })
})

describe('applyNot', () => {
  it('removes excluded items from universe', () => {
    const universe = new Set(['doc1', 'doc2', 'doc3', 'doc4'])
    const excluded = new Set(['doc2', 'doc4'])
    expect(applyNot(universe, excluded)).toEqual(new Set(['doc1', 'doc3']))
  })

  it('returns full universe when excluded set is empty', () => {
    const universe = new Set(['doc1', 'doc2'])
    expect(applyNot(universe, new Set())).toEqual(new Set(['doc1', 'doc2']))
  })

  it('returns empty set when everything is excluded', () => {
    const universe = new Set(['doc1', 'doc2'])
    expect(applyNot(universe, new Set(['doc1', 'doc2']))).toEqual(new Set())
  })

  it('ignores excluded items not in universe', () => {
    const universe = new Set(['doc1', 'doc2'])
    const excluded = new Set(['doc3', 'doc4'])
    expect(applyNot(universe, excluded)).toEqual(new Set(['doc1', 'doc2']))
  })

  it('handles empty universe', () => {
    expect(applyNot(new Set(), new Set(['doc1']))).toEqual(new Set())
  })
})
