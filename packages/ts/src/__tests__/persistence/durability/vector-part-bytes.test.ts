import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { vectorPartChunks } from '../../../persistence/durability/segment/vector-part-bytes'
import type { VectorIndexPayload } from '../../../vector/vector-index'

function partWith(vectorBytes: number): VectorIndexPayload {
  const vectors = new Uint8Array(vectorBytes)
  for (let i = 0; i < vectorBytes; i++) vectors[i] = (i * 7 + 3) & 0xff
  return {
    v: 3,
    fieldName: 'embedding',
    dimension: 4,
    part: 0,
    parts: 1,
    docIds: ['p0', 'p1'],
    graphs: [],
    codes: null,
    vectors,
  }
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

describe('the bytes of a vector part', () => {
  it('equal the MessagePack encoding of the part for every size of bin header', () => {
    for (const vectorBytes of [0, 8, 255, 256, 65_535, 65_536, 300_000]) {
      const part = partWith(vectorBytes)
      expect(joined(vectorPartChunks(part))).toEqual(encode(part))
    }
  })

  it('hands the vectors over as they are, with no copy', () => {
    const part = partWith(300_000)
    const chunks = vectorPartChunks(part)
    expect(chunks[chunks.length - 1].buffer).toBe(part.vectors.buffer)
  })
})
