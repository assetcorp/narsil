import { describe, expect, it } from 'vitest'
import {
  compareCaseFolded,
  compareCodePoints,
  compareSortStrings,
  compareSortValues,
  FOLD_ENTRY_COUNT,
  FOLD_UNICODE_VERSION,
  multiFoldTable,
  singleFoldTable,
  toComparableSortValue,
  truncateSortString,
} from '../../../core/ordering'

function foldOf(text: string): number[] {
  const single = singleFoldTable()
  const multi = multiFoldTable()
  const folded: number[] = []
  for (const character of text) {
    const cp = character.codePointAt(0)
    if (cp === undefined) continue
    const mapped = single.get(cp)
    if (mapped !== undefined) {
      folded.push(mapped)
      continue
    }
    const expansion = multi.get(cp)
    if (expansion !== undefined) {
      folded.push(...expansion)
      continue
    }
    folded.push(cp)
  }
  return folded
}

function codePoints(text: string): number[] {
  return Array.from(text, character => character.codePointAt(0) ?? 0)
}

describe('fold table', () => {
  it('pins the spec Unicode version and entry count', () => {
    expect(FOLD_UNICODE_VERSION).toBe('17.0.0')
    expect(FOLD_ENTRY_COUNT).toBe(1585)
    expect(singleFoldTable().size + multiFoldTable().size).toBe(1585)
  })

  it('reproduces the spec folding vectors', () => {
    expect(foldOf('apple')).toEqual(codePoints('apple'))
    expect(foldOf('Straße')).toEqual(codePoints('strasse'))
    expect(foldOf('ẞ')).toEqual(codePoints('ss'))
    expect(foldOf('ﬃ')).toEqual(codePoints('ffi'))
    expect(foldOf('İ')).toEqual([0x69, 0x307])
    expect(foldOf('ΣΊΣΥΦΟΣ')).toEqual(codePoints('σίσυφοσ'))
  })

  it('folds every expansion to at most three code points', () => {
    for (const expansion of multiFoldTable().values()) {
      expect(expansion.length).toBeGreaterThanOrEqual(2)
      expect(expansion.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('compareCodePoints', () => {
  it('reproduces the spec code point order vector', () => {
    const ascending = ['', 'B', 'a', 'doc-1', 'doc-10', 'doc-2', '｡', String.fromCodePoint(0x1f600)]
    for (let i = 0; i + 1 < ascending.length; i++) {
      expect(compareCodePoints(ascending[i], ascending[i + 1])).toBeLessThan(0)
      expect(compareCodePoints(ascending[i + 1], ascending[i])).toBeGreaterThan(0)
    }
  })

  it('orders a supplementary character above the basic plane, unlike raw UTF-16', () => {
    const halfwidthStop = '｡'
    const emoji = String.fromCodePoint(0x1f600)
    expect(emoji < halfwidthStop).toBe(true)
    expect(compareCodePoints(halfwidthStop, emoji)).toBeLessThan(0)
  })

  it('returns 0 only for identical strings', () => {
    expect(compareCodePoints('doc-1', 'doc-1')).toBe(0)
    expect(compareCodePoints('doc-1', 'doc-1 ')).toBeLessThan(0)
  })
})

describe('compareSortStrings', () => {
  it('reproduces the spec sort value order vector', () => {
    const ascending = ['', 'Apple', 'apple', 'Banana', 'FUSS', 'Fuß', 'fuss', 'Zebra', 'école']
    for (let i = 0; i + 1 < ascending.length; i++) {
      expect(compareSortStrings(ascending[i], ascending[i + 1])).toBeLessThan(0)
      expect(compareSortStrings(ascending[i + 1], ascending[i])).toBeGreaterThan(0)
    }
  })

  it('breaks a fold tie by raw code points', () => {
    expect(compareCaseFolded('Apple', 'apple')).toBe(0)
    expect(compareSortStrings('Apple', 'apple')).toBeLessThan(0)
  })

  it('agrees with a materialised fold on expanding characters', () => {
    expect(compareCaseFolded('Fuß', 'fuss')).toBe(0)
    expect(compareCaseFolded('ﬃ', 'ffi')).toBe(0)
    expect(compareCaseFolded('ﬃx', 'ffib')).toBeGreaterThan(0)
  })
})

describe('compareSortValues', () => {
  it('orders a missing value last under either direction', () => {
    for (const missing of [undefined, null, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compareSortValues([missing], [0], ['asc'])).toBeGreaterThan(0)
      expect(compareSortValues([missing], [0], ['desc'])).toBeGreaterThan(0)
      expect(compareSortValues([0], [missing], ['asc'])).toBeLessThan(0)
      expect(compareSortValues([0], [missing], ['desc'])).toBeLessThan(0)
    }
    expect(compareSortValues([null], [undefined], ['asc'])).toBe(0)
  })

  it('ranks numbers before strings before booleans, reversed under desc', () => {
    expect(compareSortValues([1], ['a'], ['asc'])).toBeLessThan(0)
    expect(compareSortValues(['a'], [true], ['asc'])).toBeLessThan(0)
    expect(compareSortValues([1], ['a'], ['desc'])).toBeGreaterThan(0)
    expect(compareSortValues(['a'], [true], ['desc'])).toBeGreaterThan(0)
  })

  it('compares field by field and lets the first difference decide', () => {
    expect(compareSortValues([1, 'b'], [1, 'a'], ['asc', 'asc'])).toBeGreaterThan(0)
    expect(compareSortValues([1, 'b'], [1, 'a'], ['asc', 'desc'])).toBeLessThan(0)
    expect(compareSortValues([2, 'a'], [1, 'b'], ['asc', 'asc'])).toBeGreaterThan(0)
  })

  it('compares booleans with false first', () => {
    expect(compareSortValues([false], [true], ['asc'])).toBeLessThan(0)
    expect(compareSortValues([false], [true], ['desc'])).toBeGreaterThan(0)
  })
})

describe('truncateSortString', () => {
  it('cuts to 512 code points without splitting a surrogate pair', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const long = emoji.repeat(600)
    const cut = truncateSortString(long)
    expect(Array.from(cut).length).toBe(512)
    expect(cut.length).toBe(1024)
    expect(toComparableSortValue(long)).toBe(cut)
  })

  it('leaves a short string untouched', () => {
    expect(truncateSortString('title')).toBe('title')
  })
})
