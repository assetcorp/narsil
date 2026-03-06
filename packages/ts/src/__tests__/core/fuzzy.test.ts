import { describe, it, expect } from 'vitest'
import { boundedLevenshtein } from '../../core/fuzzy'

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

  it('returns distance 0 when indexed word is a prefix of query', () => {
    const result = boundedLevenshtein('cat', 'cats', 1)
    expect(result.distance).toBe(0)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns correct distance for single insertion (non-prefix)', () => {
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
    expect(result.withinTolerance).toBe(false)
  })

  it('handles prefix matching: query starts with indexed word', () => {
    const result = boundedLevenshtein('testing', 'test', 5)
    expect(result.distance).toBe(3)
    expect(result.withinTolerance).toBe(true)
  })

  it('handles prefix matching: indexed word starts with query', () => {
    const result = boundedLevenshtein('test', 'testing', 5)
    expect(result.distance).toBe(0)
    expect(result.withinTolerance).toBe(true)
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
    expect(result.withinTolerance).toBe(false)
  })

  it('handles multi-edit distance correctly', () => {
    const result = boundedLevenshtein('kitten', 'sitting', 3)
    expect(result.distance).toBe(3)
    expect(result.withinTolerance).toBe(true)
  })

  it('returns empty string distance for non-empty comparison beyond tolerance', () => {
    const result = boundedLevenshtein('', 'abcde', 3)
    expect(result.distance).toBe(5)
    expect(result.withinTolerance).toBe(false)
  })
})
