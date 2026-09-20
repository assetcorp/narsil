import { describe, expect, it } from 'vitest'
import { compareCodePoints } from '../../../../core/ordering'
import { codePointOrder, encodeStringBlob } from '../../../../core/partition/frozen/string-blob'

const encoder = new TextEncoder()

const BASIC_PLANE = ['shoes', '', 'café', 'ｆｕｌｌ', 'crème', 'run', 'Ω', 'z', 'a']
const WITH_SUPPLEMENTARY = ['shoes', '😀', 'ｆｕｌｌ', '𝒜lpha', 'z', '\ud83d', '\ude00 after a lone half']

function bytesOneByOne(strings: readonly string[]): number[][] {
  return strings.map(text => [...encoder.encode(text)])
}

function slices(strings: readonly string[]): number[][] {
  const { blob, offsets } = encodeStringBlob(strings)
  return strings.map((_, i) => [...blob.subarray(offsets[i], offsets[i + 1])])
}

describe('a blob of UTF-8 strings', () => {
  it('holds each string as the bytes that encoding it alone gives', () => {
    expect(slices(BASIC_PLANE)).toEqual(bytesOneByOne(BASIC_PLANE))
  })

  it('keeps two lone surrogate halves apart where they meet across two strings', () => {
    expect(slices(WITH_SUPPLEMENTARY)).toEqual(bytesOneByOne(WITH_SUPPLEMENTARY))
  })

  it('encodes no strings as an empty blob', () => {
    const { blob, offsets } = encodeStringBlob([])
    expect(blob.length).toBe(0)
    expect([...offsets]).toEqual([0])
  })
})

describe('the code point order of a list of strings', () => {
  function byComparator(strings: readonly string[]): number[] {
    return strings.map((_, i) => i).sort((a, b) => compareCodePoints(strings[a], strings[b]))
  }

  it('matches the code point comparator for basic-plane strings', () => {
    expect(codePointOrder(BASIC_PLANE)).toEqual(byComparator(BASIC_PLANE))
  })

  it('matches the code point comparator where a supplementary character must order last', () => {
    expect(codePointOrder(WITH_SUPPLEMENTARY)).toEqual(byComparator(WITH_SUPPLEMENTARY))
  })

  it('keeps a list that is in code point order already, supplementary characters included', () => {
    const ordered = ['a', 'b', 'b', 'z', 'ｆｕｌｌ', '😀']
    expect(codePointOrder(ordered)).toEqual([0, 1, 2, 3, 4, 5])
    expect(codePointOrder(ordered)).toEqual(byComparator(ordered))
  })

  it('matches the code point comparator where a string repeats', () => {
    const repeated = ['b', 'a', 'b', 'c', 'a']
    expect(codePointOrder(repeated)).toEqual(byComparator(repeated))
  })
})
