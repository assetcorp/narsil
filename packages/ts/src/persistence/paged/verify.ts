import { ErrorCodes, NarsilError } from '../../errors'
import { crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
import { HEADER_SIZE, readHeader } from '../../serialization/header'
import type { DurableDirectory } from '../durability/durable-filesystem'
import { FILE_ASSEMBLY_CHUNK_BYTES } from './constants'
import { loadFailed, PAGED_SEGMENT_ENVELOPE_VERSION } from './format'
import type { PagedFileListing } from './resident'

async function orLoadFailure<T>(key: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof NarsilError) throw error
    return loadFailed(
      `The segment "${key}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      {
        key,
      },
    )
  }
}

export async function envelopeVersionOf(directory: DurableDirectory, key: string): Promise<number> {
  const { readRange } = directory
  if (readRange === undefined) return loadFailed(`The directory holding "${key}" reads no ranges`, { key })
  const bytes = await orLoadFailure(key, () => readRange.call(directory, key, 4, 1))
  return bytes[0]
}

export async function isPagedSegmentFile(directory: DurableDirectory, key: string): Promise<boolean> {
  return (await envelopeVersionOf(directory, key)) === PAGED_SEGMENT_ENVELOPE_VERSION
}

export async function requirePagedPayloadChecksum(
  directory: DurableDirectory,
  listing: PagedFileListing,
): Promise<void> {
  const { readRange } = directory
  const { key, bytes } = listing
  if (readRange === undefined) return loadFailed(`The directory holding "${key}" reads no ranges`, { key })
  const header = readHeader(await readRange.call(directory, key, 0, HEADER_SIZE))
  if (HEADER_SIZE + header.payloadLength !== bytes) {
    loadFailed(`The segment "${key}" holds ${bytes} bytes where its header gives ${HEADER_SIZE + header.payloadLength}`)
  }
  let state = crc32Init()
  for (let at = HEADER_SIZE; at < bytes; at += FILE_ASSEMBLY_CHUNK_BYTES) {
    const size = Math.min(FILE_ASSEMBLY_CHUNK_BYTES, bytes - at)
    state = crc32Update(state, await readRange.call(directory, key, at, size))
  }
  const computed = crc32Final(state)
  if (computed !== header.checksum) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_CRC_MISMATCH,
      `The checksum of the segment "${key}" does not match its payload`,
      { key, expected: header.checksum, computed },
    )
  }
}

export async function pagedListingOf(
  directory: DurableDirectory,
  ref: { key: string; bytes: number; checksum: number },
): Promise<PagedFileListing> {
  const { byteLength } = directory
  const length = byteLength === undefined ? ref.bytes : await byteLength.call(directory, ref.key)
  if (length === null) loadFailed(`The segment "${ref.key}" that the manifest lists is missing`, { key: ref.key })
  if (length !== ref.bytes) {
    loadFailed(`The segment "${ref.key}" holds ${length} bytes where the manifest lists ${ref.bytes}`, {
      key: ref.key,
      bytes: length,
      listed: ref.bytes,
    })
  }
  return { key: ref.key, path: await directory.pathOf(ref.key), bytes: ref.bytes, checksum: ref.checksum }
}
