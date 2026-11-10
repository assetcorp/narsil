import { VERSION } from '#platform/suggestion-store-host'
import { checksumOfChunks } from './chunk-checksum'
import {
  type PackedEnvelope,
  packEnvelopeWithEngineVersion,
  payloadByteLength,
  requireWithinFileLimit,
} from './envelope-codec'
import { HEADER_SIZE } from './header'

export {
  openChecksummedEnvelope,
  type PackedEnvelope,
  payloadByteLength,
  requireWithinFileLimit,
} from './envelope-codec'

export function engineVersionParts(): [number, number, number] {
  const parts = VERSION.split('.')
  return [
    Number.parseInt(parts[0] ?? '0', 10),
    Number.parseInt(parts[1] ?? '0', 10),
    Number.parseInt(parts[2] ?? '0', 10),
  ]
}

export async function packChecksummedEnvelope(
  payloadChunks: readonly Uint8Array[],
  envelopeFormatVersion: number,
  what: string,
): Promise<PackedEnvelope> {
  requireWithinFileLimit(HEADER_SIZE + payloadByteLength(payloadChunks), what)
  return packEnvelopeWithChecksum(payloadChunks, envelopeFormatVersion, what, await checksumOfChunks(payloadChunks))
}

export function packEnvelopeWithChecksum(
  payloadChunks: readonly Uint8Array[],
  envelopeFormatVersion: number,
  what: string,
  checksum: number,
): PackedEnvelope {
  return packEnvelopeWithEngineVersion(payloadChunks, envelopeFormatVersion, what, checksum, engineVersionParts())
}
