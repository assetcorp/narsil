import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { decodeMapWithoutFields } from '../../serialization/msgpack-without-fields'

const EVERY_VALUE_SHAPE = {
  title: 'Harbour lights',
  longText: 'x'.repeat(70_000),
  mediumText: 'y'.repeat(300),
  year: 1987,
  negative: -40_000,
  big: 2 ** 40,
  bigNegative: -(2 ** 40),
  ratio: 0.125,
  flag: true,
  off: false,
  nothing: null,
  bytes: new Uint8Array([1, 2, 3]),
  manyBytes: new Uint8Array(70_000).fill(7),
  tags: ['sea', 'night', ['nested', 1]],
  manyNumbers: Array.from({ length: 70_000 }, (_, i) => i),
  place: { lat: 5.6, lon: -0.2, names: { short: 'Accra' } },
  wideMap: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])),
  embedding: Array.from({ length: 1536 }, (_, i) => Math.fround(Math.sin(i))),
  packedEmbedding: new Uint8Array(new Float32Array([0.5, 0.25]).buffer),
}

describe('decoding a logged document without its vector fields', () => {
  it('returns every other field as the full decoder returns it', () => {
    const bytes = encode(EVERY_VALUE_SHAPE)
    const { embedding: _embedding, packedEmbedding: _packed, ...rest } = decode(bytes) as typeof EVERY_VALUE_SHAPE

    const decoded = decodeMapWithoutFields(bytes, new Set(['embedding', 'packedEmbedding']))

    expect(decoded).toEqual(rest)
  })

  it('reads a document that sits inside a larger buffer', () => {
    const document = encode({ title: 'offset', embedding: [1.5, 2.5], year: 3 })
    const buffer = new Uint8Array(document.length + 9)
    buffer.set(document, 5)

    expect(decodeMapWithoutFields(buffer.subarray(5, 5 + document.length), new Set(['embedding']))).toEqual({
      title: 'offset',
      year: 3,
    })
  })

  it('leaves a document that it cannot split to the full decoder', () => {
    const skipped = new Set(['embedding'])
    expect(decodeMapWithoutFields(encode([1, 2, 3]), skipped)).toBeNull()
    expect(decodeMapWithoutFields(new Uint8Array([0x81, 0x01, 0xa1, 0x61]), skipped)).toBeNull()
    expect(
      decodeMapWithoutFields(encode({ title: 'cut short', embedding: [1, 2, 3] }).subarray(0, 14), skipped),
    ).toBeNull()
    expect(decodeMapWithoutFields(new Uint8Array([0x81, 0xa9, ...Buffer.from('__proto__'), 0x01]), skipped)).toBeNull()
  })
})
