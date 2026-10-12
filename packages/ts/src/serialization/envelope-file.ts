import { ErrorCodes, NarsilError } from '../errors'
import { VERSION } from '../index'
import { checksumOfChunks } from './chunk-checksum'
import { MAX_FILE_BYTES } from './constants'
import { HEADER_SIZE, type NrslHeader, readHeader, writeHeader } from './header'

export interface PackedEnvelope {
  chunks: Uint8Array[]
  byteLength: number
  checksum: number
}

export interface OpenedEnvelope {
  header: NrslHeader
  payload: Uint8Array
}

const RESERVED_BYTES = 14

export function engineVersionParts(): [number, number, number] {
  const parts = VERSION.split('.')
  return [
    Number.parseInt(parts[0] ?? '0', 10),
    Number.parseInt(parts[1] ?? '0', 10),
    Number.parseInt(parts[2] ?? '0', 10),
  ]
}

export function payloadByteLength(chunks: readonly Uint8Array[]): number {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  return total
}

export function requireWithinFileLimit(byteLength: number, what: string): void {
  if (byteLength <= MAX_FILE_BYTES) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `The ${what} would take ${byteLength} bytes, above the file size limit of ${MAX_FILE_BYTES}`,
    { bytes: byteLength, maximum: MAX_FILE_BYTES },
  )
}

export async function packChecksummedEnvelope(
  payloadChunks: readonly Uint8Array[],
  envelopeFormatVersion: number,
  what: string,
): Promise<PackedEnvelope> {
  const payloadLength = payloadByteLength(payloadChunks)
  requireWithinFileLimit(HEADER_SIZE + payloadLength, what)
  const checksum = await checksumOfChunks(payloadChunks)
  const [major, minor, patch] = engineVersionParts()
  const header = writeHeader({
    magic: 'NRSL',
    envelopeFormatVersion,
    engineVersionMajor: major,
    engineVersionMinor: minor,
    engineVersionPatch: patch,
    payloadLength,
    flags: { compressionEnabled: false, compressionAlgorithm: 'none', checksumPresent: true, encryptionEnabled: false },
    checksum,
    reserved: new Uint8Array(RESERVED_BYTES),
  })
  return { chunks: [header, ...payloadChunks], byteLength: HEADER_SIZE + payloadLength, checksum }
}

function loadFailed(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, message, details)
}

async function gunzipWithinLimit(compressed: Uint8Array, what: string): Promise<Uint8Array> {
  const source = new Blob([compressed.slice().buffer as ArrayBuffer]).stream()
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>
    try {
      step = await reader.read()
    } catch (error) {
      loadFailed(`The ${what} holds a gzip payload that fails to inflate`, {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    if (step.done) break
    total += step.value.byteLength
    if (total > MAX_FILE_BYTES) {
      await reader.cancel()
      loadFailed(`The ${what} inflates past the file size limit of ${MAX_FILE_BYTES} bytes`)
    }
    chunks.push(step.value)
  }
  const inflated = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    inflated.set(chunk, offset)
    offset += chunk.byteLength
  }
  return inflated
}

export interface EnvelopeExpectation {
  envelopeFormatVersion: number
  what: string
  allowsCompression: boolean
}

export async function openChecksummedEnvelope(
  data: Uint8Array,
  expected: EnvelopeExpectation,
): Promise<OpenedEnvelope> {
  const { envelopeFormatVersion, what } = expected
  const header = readHeader(data)
  if (header.envelopeFormatVersion !== envelopeFormatVersion) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The ${what} holds envelope format v${header.envelopeFormatVersion}, while this build reads it as v${envelopeFormatVersion}`,
      { version: header.envelopeFormatVersion, expected: envelopeFormatVersion },
    )
  }
  if (header.flags.encryptionEnabled) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The ${what} is encrypted, which this build cannot read`,
    )
  }
  if (header.flags.compressionEnabled && !expected.allowsCompression) {
    loadFailed(`The ${what} is compressed, while its format stores it raw`)
  }
  if (header.flags.compressionEnabled && header.flags.compressionAlgorithm !== 'gzip') {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The ${what} uses ${header.flags.compressionAlgorithm} compression, which this build cannot read`,
    )
  }
  if (!header.flags.checksumPresent) loadFailed(`The ${what} carries no checksum, while its format requires one`)
  if (data.byteLength !== HEADER_SIZE + header.payloadLength) {
    loadFailed(
      `The ${what} holds ${data.byteLength} bytes where its header gives ${HEADER_SIZE + header.payloadLength}`,
      { bytes: data.byteLength, expected: HEADER_SIZE + header.payloadLength },
    )
  }
  const payload = data.subarray(HEADER_SIZE)
  const computed = await checksumOfChunks([payload])
  if (computed !== header.checksum) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_CRC_MISMATCH,
      `The checksum of the ${what} does not match its payload`,
      {
        expected: header.checksum,
        computed,
      },
    )
  }
  if (header.flags.compressionEnabled) return { header, payload: await gunzipWithinLimit(payload, what) }
  return { header, payload }
}
