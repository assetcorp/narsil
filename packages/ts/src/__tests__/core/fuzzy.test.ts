import { describe, expect, it } from 'vitest'
import { boundedLevenshtein, fuzzyTermMatches } from '../../core/fuzzy'

describe('boundedLevenshtein', () => {
  it('returns distance 0 for identical strings', () => {
    const result = boundedLevenshtein('hello', 'hello', 2)
    expect(result.distance).toBe(0)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns correct distance for single substitution', () => {
    const result = boundedLevenshtein('cat', 'bat', 1)
    expect(result.distance).toBe(1)
    expect(result.withinTolerance).toBe(true)
  })

  it('counts each added character when the indexed word starts with the query', () => {
    expect(boundedLevenshtein('cat', 'cats', 1)).toEqual({ distance: 1, withinTolerance: true })
    expect(boundedLevenshtein('sec', 'secur', 1)).toEqual({ distance: 2, withinTolerance: false })
  })

  it('returns correct distance for single insertion inside the word', () => {
    const result = boundedLevenshtein('cat', 'cart', 1)
    expect(result.distance).toBe(1)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns correct distance for single deletion', () => {
    const result = boundedLevenshtein('cats', 'cat', 1)
    expect(result.distance).toBe(1)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns withinTolerance false when distance exceeds tolerance', () => {
    const result = boundedLevenshtein('hello', 'world', 2)
    expect(result.withinTolerance).toBe(false)
  })

  it('handles empty first string', () => {
    const result = boundedLevenshtein('', 'abc', 3)
    expect(result.distance).toBe(3)
    expect(result.withinTolerance).toBe(true)
  })

  it('handles empty second string', () => {
    const result = boundedLevenshtein('abc', '', 3)
    expect(result.distance).toBe(3)
    expect(result.withinTolerance).toBe(true)
  })

  it('handles both empty strings', () => {
    const result = boundedLevenshtein('', '', 0)
    expect(result.distance).toBe(0)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns early when length difference exceeds tolerance', () => {
    const result = boundedLevenshtein('hi', 'hello', 1)
    expect(result.distance).toBe(2)
    expect(result.withinTolerance).toBe(false)
  })

  it('rejects negative tolerance', () => {
    const result = boundedLevenshtein('a', 'b', -1)
    expect(result.distance).toBe(-1)
    expect(result.withinTolerance).toBe(false)
  })

  it('handles tolerance of 0 for different strings', () => {
    const result = boundedLevenshtein('abc', 'abd', 0)
    expect(result.withinTolerance).toBe(false)
  })

  it('handles tolerance of 0 for equal strings', () => {
    const result = boundedLevenshtein('abc', 'abc', 0)
    expect(result.distance).toBe(0)
    expect(result.withinTolerance).toBe(true)
  })

  it('terminates early when all row values exceed tolerance', () => {
    const result = boundedLevenshtein('abcdef', 'zyxwvu', 1)
    expect(result.distance).toBe(2)
    expect(result.withinTolerance).toBe(false)
  })

  it('handles multi-edit distance correctly', () => {
    const result = boundedLevenshtein('kitten', 'sitting', 3)
    expect(result.distance).toBe(3)
    expect(result.withinTolerance).toBe(true)
  })

  it('counts a supplementary character as one edit', () => {
    expect(boundedLevenshtein('a', '\u{1F600}', 1)).toEqual({ distance: 1, withinTolerance: true })
  })

  it('checks two long words in time that grows with their length', () => {
    const shared = 'a'.repeat(100_000)
    expect(boundedLevenshtein(`${shared}b`, `${shared}c`, 1)).toEqual({ distance: 1, withinTolerance: true })
  })
})

describe('fuzzyTermMatches', () => {
  it('applies prefixLength in code points and to the whole of a shorter query term', () => {
    expect(fuzzyTermMatches('\u{1F600}a', '\u{1F603}a', 1, 1)).toBe(false)
    expect(fuzzyTermMatches('rum', 'run', 1, 4)).toBe(false)
    expect(fuzzyTermMatches('rum', 'run', 1, 2)).toBe(true)
  })
})
