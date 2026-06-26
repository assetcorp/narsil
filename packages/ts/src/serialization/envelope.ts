import { ErrorCodes, NarsilError } from '../errors'
import { VERSION } from '../index'
import type { IndexMetadata, SerializablePartition } from '../types/internal'
import { computeOffThreadChecksum } from './checksum-dispatch'
import { crc32 } from './crc32'
import type { NrslFlags, NrslHeader } from './header'
import { HEADER_SIZE, readHeader, writeHeader } from './header'
import { deserializeMetadata, deserializePayloadV1, serializeMetadata, serializePayloadV1 } from './payload-v1'

export interface EnvelopeParts {
  header: Uint8Array
  payload: Uint8Array
}

const CURRENT_ENVELOPE_VERSION = 1
const SNAPSHOT_ENVELOPE_VERSION = 2

export interface EnvelopeOptions {
  compression?: 'none' | 'gzip'
  checksum?: boolean
  envelopeFormatVersion?: number
}

function parseEngineVersion(version: string): [number, number, number] {
  const parts = version.split('.')
  return [parseInt(parts[0] ?? '0', 10), parseInt(parts[1] ?? '0', 10), parseInt(parts[2] ?? '0', 10)]
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLength += value.length
  }

  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([toArrayBuffer(data)])
  const compressed = blob.stream().pipeThrough(new CompressionStream('gzip'))
  return collectStream(compressed)
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([toArrayBuffer(data)])
  const decompressed = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  return collectStream(decompressed)
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
    finalPayload = await compressGzip(payloadBytes)
  }

  const checksum = flags.checksumPresent ? crc32(finalPayload) : 0
  const [major, minor, patch] = parseEngineVersion(VERSION)
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
      `This data was written by Narsil envelope format v${header.envelopeFormatVersion}` +
        ` and requires a newer version of Narsil. You are running ${VERSION}.`,
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
    payloadBytes = await decompressGzip(payloadBytes)
  }

  return { header, payloadBytes }
}

export async function packEnvelopeBytes(payloadBytes: Uint8Array, options: EnvelopeOptions = {}): Promise<Uint8Array> {
  return packEnvelope(payloadBytes, { ...options, envelopeFormatVersion: SNAPSHOT_ENVELOPE_VERSION })
}

export async function packSnapshotEnvelopeParts(payloadBytes: Uint8Array): Promise<EnvelopeParts> {
  const { checksum, payload } = await computeOffThreadChecksum(payloadBytes)
  const [major, minor, patch] = parseEngineVersion(VERSION)

  const header: NrslHeader = {
    magic: 'NRSL',
    envelopeFormatVersion: SNAPSHOT_ENVELOPE_VERSION,
    engineVersionMajor: major,
    engineVersionMinor: minor,
    engineVersionPatch: patch,
    payloadLength: payload.length,
    flags: {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: true,
      encryptionEnabled: false,
    },
    checksum,
    reserved: new Uint8Array(14),
  }

  return { header: writeHeader(header), payload }
}

export function concatEnvelopeParts(parts: EnvelopeParts): Uint8Array {
  const combined = new Uint8Array(parts.header.length + parts.payload.length)
  combined.set(parts.header, 0)
  combined.set(parts.payload, parts.header.length)
  return combined
}

export async function unpackEnvelopeBytes(data: Uint8Array): Promise<{ header: NrslHeader; payloadBytes: Uint8Array }> {
  return unpackEnvelope(data, SNAPSHOT_ENVELOPE_VERSION)
}

export async function writePartitionEnvelope(
  partition: SerializablePartition,
  options: EnvelopeOptions = {},
): Promise<Uint8Array> {
  const payloadBytes = serializePayloadV1(partition)
  return packEnvelope(payloadBytes, options)
}

export async function readPartitionEnvelope(
  data: Uint8Array,
): Promise<{ header: NrslHeader; partition: SerializablePartition }> {
  const { header, payloadBytes } = await unpackEnvelope(data)
  const partition = deserializePayloadV1(payloadBytes)
  return { header, partition }
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

export { CURRENT_ENVELOPE_VERSION, SNAPSHOT_ENVELOPE_VERSION }
