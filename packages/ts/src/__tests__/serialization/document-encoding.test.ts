import { describe, expect, it } from 'vitest'
import { encodeDocument } from '../../serialization/document-encoding'

const ascii = (text: string): number[] => [...text].map(character => character.charCodeAt(0))

const INNER_BYTES = [0x81, 0xa1, ...ascii('b'), 0x02]
const OUTER_BYTES = [0x82, 0xa5, ...ascii('inner'), 0xa1, ...ascii('x'), 0xa4, ...ascii('tail'), 0xa2, ...ascii('yy')]

describe('encodeDocument', () => {
  it('keeps both encodings intact when a getter on the document encodes another document', () => {
    let innerEncoding: Uint8Array | undefined
    const outer = {
      get inner(): string {
        innerEncoding = encodeDocument({ b: 2 })
        return 'x'
      },
      tail: 'yy',
    }

    const outerEncoding = encodeDocument(outer)

    expect([...outerEncoding]).toEqual(OUTER_BYTES)
    expect(innerEncoding === undefined ? undefined : [...innerEncoding]).toEqual(INNER_BYTES)
  })

  it('returns bytes that own their whole buffer and stay unchanged by the next encoding', () => {
    const first = encodeDocument({ b: 2 })
    encodeDocument({ inner: 'x', tail: 'yy' })

    expect(first.byteOffset).toBe(0)
    expect(first.buffer.byteLength).toBe(INNER_BYTES.length)
    expect([...first]).toEqual(INNER_BYTES)
  })
})
