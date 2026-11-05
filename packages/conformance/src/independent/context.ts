import type { FormContext } from '../forms/codec'
import { type Decoded, FormError } from '../forms/decoded'
import { crc32 } from './crc32'
import { decodedOf, unpackDecoded } from './decoded'
import { unpackPrefix } from './msgpack'
import { openNrsl } from './nrsl'

function unpackSequence(bytes: Uint8Array): Decoded[] {
  const values: Decoded[] = []
  let at = 0
  while (at < bytes.byteLength) {
    const { value, length } = unpackPrefix(bytes.subarray(at))
    values.push(decodedOf(value))
    at += length
  }
  return values
}

export const independentContext: FormContext = {
  openEnvelope: async bytes => {
    const file = openNrsl(bytes)
    return {
      header: {
        envelopeFormatVersion: file.envelopeFormatVersion,
        compression: file.compression,
        checksum: file.checksumPresent,
      },
      payload: file.payload,
    }
  },
  unpack: bytes => unpackDecoded(bytes),
  unpackSequence,
  pack: (_value, what) => {
    throw new FormError(`the independent decoder writes no MessagePack, so it cannot write ${what}`)
  },
  crc32,
}
