import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeBytesMessage, encodeBytesMessage } from '../../../../distribution/transport/grpc/codec'
import { OPEN_STREAM_METHOD_PATH, SEND_METHOD_PATH } from '../../../../distribution/transport/grpc/service'
import { TransportError } from '../../../../distribution/transport/types'

describe('protobuf envelope codec', () => {
  it('encodes a payload as field one with a length-delimited wire type', () => {
    const encoded = encodeBytesMessage(new Uint8Array([1, 2, 3]))

    expect(Array.from(encoded)).toEqual([0x0a, 0x03, 1, 2, 3])
  })

  it('encodes an empty payload with a zero length', () => {
    const encoded = encodeBytesMessage(new Uint8Array(0))

    expect(Array.from(encoded)).toEqual([0x0a, 0x00])
  })

  it('encodes a payload above 127 bytes with a two-byte varint length', () => {
    const payload = new Uint8Array(300).fill(7)
    const encoded = encodeBytesMessage(payload)

    expect(Array.from(encoded.subarray(0, 3))).toEqual([0x0a, 0xac, 0x02])
    expect(encoded.byteLength).toBe(3 + 300)
  })

  it('round-trips payloads of every size class', () => {
    for (const size of [0, 1, 127, 128, 300, 20_000]) {
      const payload = new Uint8Array(size)
      for (let index = 0; index < size; index++) {
        payload[index] = index % 251
      }

      expect(new Uint8Array(decodeBytesMessage(encodeBytesMessage(payload)))).toEqual(payload)
    }
  })

  it('decodes an empty message as an empty payload', () => {
    expect(decodeBytesMessage(new Uint8Array(0))).toEqual(new Uint8Array(0))
  })

  it('skips unknown varint, fixed32, fixed64, and length-delimited fields', () => {
    const data = new Uint8Array([
      0x10, 0x96, 0x01, 0x1d, 1, 2, 3, 4, 0x21, 1, 2, 3, 4, 5, 6, 7, 8, 0x2a, 0x02, 9, 9, 0x0a, 0x02, 42, 43,
    ])

    expect(decodeBytesMessage(data)).toEqual(new Uint8Array([42, 43]))
  })

  it('rejects a truncated varint', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x0a, 0x80]))).toThrow(TransportError)
  })

  it('rejects a length that runs past the end of the buffer', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x0a, 0x05, 1, 2]))).toThrow(TransportError)
  })

  it('rejects a varint above five bytes', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).toThrow(TransportError)
  })

  it('rejects the deprecated group wire types', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x0b]))).toThrow(TransportError)
    expect(() => decodeBytesMessage(new Uint8Array([0x0c]))).toThrow(TransportError)
  })

  it('rejects field number zero', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x02, 0x00]))).toThrow(TransportError)
  })

  it('rejects a truncated fixed-width field', () => {
    expect(() => decodeBytesMessage(new Uint8Array([0x15, 1, 2]))).toThrow(TransportError)
    expect(() => decodeBytesMessage(new Uint8Array([0x11, 1, 2, 3, 4]))).toThrow(TransportError)
  })
})

describe('method paths against the specification', () => {
  it('matches the service and methods that transport.proto defines', () => {
    const protoUrl = new URL('../../../../../../spec/distribution/transport.proto', import.meta.url)
    const proto = readFileSync(protoUrl, 'utf-8')

    expect(proto).toContain('package narsil.transport.v1;')
    expect(proto).toContain('rpc Send(Envelope) returns (Envelope);')
    expect(proto).toContain('rpc OpenStream(Envelope) returns (stream Chunk);')
    expect(SEND_METHOD_PATH).toBe('/narsil.transport.v1.NodeTransport/Send')
    expect(OPEN_STREAM_METHOD_PATH).toBe('/narsil.transport.v1.NodeTransport/OpenStream')
  })
})
