import { crc32 } from '../../../ts/src/serialization/crc32'
import { engineVersionParts } from '../../../ts/src/serialization/envelope-file'
import { gzip } from '../../../ts/src/serialization/gzip'
import { HEADER_SIZE, writeHeader } from '../../../ts/src/serialization/header'
import type { HeaderForm } from '../forms/header'

const RESERVED_BYTES = 14

export function joined(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

export async function packedEnvelope(payloadChunks: readonly Uint8Array[], header: HeaderForm): Promise<Uint8Array> {
  const raw = joined(payloadChunks)
  const stored = header.compression === 'gzip' ? await gzip(raw) : raw
  const [major, minor, patch] = engineVersionParts()
  const headerBytes = writeHeader({
    magic: 'NRSL',
    envelopeFormatVersion: header.envelopeFormatVersion,
    engineVersionMajor: major,
    engineVersionMinor: minor,
    engineVersionPatch: patch,
    payloadLength: stored.byteLength,
    flags: {
      compressionEnabled: header.compression === 'gzip',
      compressionAlgorithm: header.compression,
      checksumPresent: header.checksum,
      encryptionEnabled: false,
    },
    checksum: header.checksum ? crc32(stored) : 0,
    reserved: new Uint8Array(RESERVED_BYTES),
  })
  const file = new Uint8Array(HEADER_SIZE + stored.byteLength)
  file.set(headerBytes)
  file.set(stored, HEADER_SIZE)
  return file
}
