import {
  crc32,
  ErrorCodes,
  engineVersionParts,
  HEADER_SIZE,
  loadGzip,
  NarsilError,
  readHeader,
  writeHeader,
} from '#platform/storage-host'
import type { IndexMetadata } from '../types/internal'
import type { NrslFlags, NrslHeader } from './header'
import { deserializeMetadata, serializeMetadata } from './payload-v1'

const CURRENT_ENVELOPE_VERSION = 1
const SNAPSHOT_ENVELOPE_VERSION = 2
const INDEX_SNAPSHOT_ENVELOPE_VERSION = 3

export interface EnvelopeOptions {
  compression?: 'none' | 'gzip'
  checksum?: boolean
  envelopeFormatVersion?: number
}

function buildFlags(options: EnvelopeOptions): NrslFlags {
  const useCompression = options.compression === 'gzip'
  return {
    compressionEnabled: useCompression,
    compressionAlgorithm: useCompression ? 'gzip' : 'none',
    checksumPresent: options.checksum ?? false,
    encryptionEnabled: false,
  }
}

async function packEnvelope(payloadBytes: Uint8Array, options: EnvelopeOptions): Promise<Uint8Array> {
  const flags = buildFlags(options)

  let finalPayload = payloadBytes
  if (flags.compressionEnabled) {
    const { gzip } = await loadGzip()
    finalPayload = await gzip(payloadBytes)
  }

  const checksum = flags.checksumPresent ? crc32(finalPayload) : 0
  const [major, minor, patch] = engineVersionParts()
  const envelopeFormatVersion = options.envelopeFormatVersion ?? CURRENT_ENVELOPE_VERSION

  const header: NrslHeader = {
    magic: 'NRSL',
    envelopeFormatVersion,
    engineVersionMajor: major,
    engineVersionMinor: minor,
    engineVersionPatch: patch,
    payloadLength: finalPayload.length,
    flags,
    checksum,
    reserved: new Uint8Array(14),
  }

  const headerBytes = writeHeader(header)
  const envelope = new Uint8Array(HEADER_SIZE + finalPayload.length)
  envelope.set(headerBytes, 0)
  envelope.set(finalPayload, HEADER_SIZE)

  return envelope
}

async function unpackEnvelope(
  data: Uint8Array,
  maxAcceptedVersion: number = CURRENT_ENVELOPE_VERSION,
): Promise<{ header: NrslHeader; payloadBytes: Uint8Array }> {
  const header = readHeader(data)

  if (header.envelopeFormatVersion > maxAcceptedVersion) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `This data holds Narsil envelope format v${header.envelopeFormatVersion},` +
        ` while this build of @delali/narsil reads up to v${maxAcceptedVersion}, so upgrade the package to read it.`,
    )
  }

  if (header.flags.encryptionEnabled) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      'Encrypted envelopes are not supported in this version of Narsil',
    )
  }

  const compAlgo = header.flags.compressionAlgorithm
  if (header.flags.compressionEnabled && compAlgo !== 'gzip' && compAlgo !== 'none') {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `Compression algorithm "${compAlgo}" is not supported in this version of Narsil`,
    )
  }

  const availablePayload = data.length - HEADER_SIZE
  if (availablePayload < header.payloadLength) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Envelope data is truncated: header declares ${header.payloadLength} bytes of payload but only ${availablePayload} bytes are available`,
    )
  }

  let payloadBytes: Uint8Array = new Uint8Array(data.slice(HEADER_SIZE, HEADER_SIZE + header.payloadLength))

  if (header.flags.checksumPresent) {
    const computed = crc32(payloadBytes)
    if (computed !== header.checksum) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_CRC_MISMATCH, 'CRC32 checksum mismatch: data may be corrupted', {
        expected: header.checksum,
        computed,
      })
    }
  }

  if (header.flags.compressionEnabled) {
    const { gunzip } = await loadGzip()
    payloadBytes = await gunzip(payloadBytes)
  }

  return { header, payloadBytes }
}

export async function unpackEnvelopeBytes(data: Uint8Array): Promise<{ header: NrslHeader; payloadBytes: Uint8Array }> {
  return unpackEnvelope(data, SNAPSHOT_ENVELOPE_VERSION)
}

export async function unpackIndexSnapshotEnvelope(data: Uint8Array): Promise<Uint8Array> {
  const { header, payloadBytes } = await unpackEnvelope(data, INDEX_SNAPSHOT_ENVELOPE_VERSION)
  if (header.envelopeFormatVersion !== INDEX_SNAPSHOT_ENVELOPE_VERSION) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `Expected an index snapshot envelope of format v${INDEX_SNAPSHOT_ENVELOPE_VERSION}, received format v${header.envelopeFormatVersion}`,
    )
  }
  return payloadBytes
}

export async function writeMetadataEnvelope(meta: IndexMetadata, options: EnvelopeOptions = {}): Promise<Uint8Array> {
  const payloadBytes = serializeMetadata(meta)
  return packEnvelope(payloadBytes, options)
}

export async function readMetadataEnvelope(data: Uint8Array): Promise<{ header: NrslHeader; metadata: IndexMetadata }> {
  const { header, payloadBytes } = await unpackEnvelope(data)
  const metadata = deserializeMetadata(payloadBytes)
  return { header, metadata }
}

export { CURRENT_ENVELOPE_VERSION, INDEX_SNAPSHOT_ENVELOPE_VERSION, SNAPSHOT_ENVELOPE_VERSION }
