import { MAX_FILE_BYTES } from '../../serialization/constants'
import { HEADER_SIZE } from '../../serialization/header'
import { type FileRef, manifestFileRefs, type SegmentManifest } from '../durability/segment/manifest'
import { decodeManifestPayload, listedKeysOf, openManifestPayload } from '../durability/segment/manifest-decode'
import type { ByteReader } from './byte-reader'
import { MAX_PAX_HEADER_BYTES } from './constants'
import { invalidArchive, isZeroBlock, parsePaxRecords, parseTarHeader, TAR_BLOCK_BYTES } from './tar'

export const ARCHIVE_CONFIG_ENTRY = 'config'
export const ARCHIVE_MANIFEST_ENTRY = 'manifest'
const SEGMENTS_MARKER = '/segments/'
const CHECKSUM_OFFSET = 14

interface EntryHeader {
  name: string
  size: number
}

export interface ArchiveReadHandlers {
  config(bytes: Uint8Array): Promise<void>
  manifest(manifest: SegmentManifest, sourceIndexName: string): Promise<void>
  file(entryName: string, ref: FileRef, bytes: Uint8Array): Promise<void>
}

async function readBlock(reader: ByteReader): Promise<Uint8Array | null> {
  const block = await reader.readExactly(TAR_BLOCK_BYTES)
  if (block === null) return null
  if (block.byteLength < TAR_BLOCK_BYTES) invalidArchive('the archive ends inside an entry header')
  return block
}

async function readPadded(reader: ByteReader, size: number): Promise<Uint8Array> {
  const body = (await reader.readExactly(size)) ?? new Uint8Array(0)
  if (body.byteLength < size) invalidArchive('the archive ends inside an entry')
  const remainder = size % TAR_BLOCK_BYTES
  if (remainder !== 0) {
    const padding = await reader.readExactly(TAR_BLOCK_BYTES - remainder)
    if (padding === null || padding.byteLength < TAR_BLOCK_BYTES - remainder) {
      invalidArchive('the archive ends inside the padding of an entry')
    }
  }
  return body
}

async function nextEntryHeader(reader: ByteReader): Promise<EntryHeader | null> {
  const block = await readBlock(reader)
  if (block === null || isZeroBlock(block)) return null
  const header = parseTarHeader(block)
  if (!header.isPaxHeader) return { name: header.name, size: header.size }
  if (header.size > MAX_PAX_HEADER_BYTES) invalidArchive('a pax extended header is too long')
  const records = parsePaxRecords(await readPadded(reader, header.size))
  const next = await readBlock(reader)
  if (next === null || isZeroBlock(next)) invalidArchive('a pax extended header precedes no entry')
  const entry = parseTarHeader(next)
  if (entry.isPaxHeader) invalidArchive('a pax extended header follows another')
  const path = records.get('path')
  const size = records.get('size')
  const parsedSize = size === undefined ? entry.size : Number.parseInt(size, 10)
  if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) invalidArchive('a pax extended header holds an invalid size')
  return { name: path ?? entry.name, size: parsedSize }
}

async function readNamedEntry(reader: ByteReader, expected: string): Promise<Uint8Array> {
  const header = await nextEntryHeader(reader)
  if (header === null) invalidArchive(`the archive ends before its ${expected} entry`)
  if (header.name !== expected) invalidArchive(`the archive holds "${header.name}" where its ${expected} entry belongs`)
  if (header.size > MAX_FILE_BYTES) invalidArchive(`the ${expected} entry passes the file size limit`)
  return readPadded(reader, header.size)
}

function sourceIndexNameOf(keys: readonly string[]): string {
  const first = keys[0]
  if (first === undefined) return 'archive'
  const at = first.indexOf(SEGMENTS_MARKER)
  if (at <= 0) invalidArchive(`the manifest lists the key "${first}" outside any index`)
  return first.slice(0, at)
}

function headerChecksumOf(bytes: Uint8Array): number {
  if (bytes.byteLength < HEADER_SIZE) return -1
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(CHECKSUM_OFFSET, false)
}

export async function readSnapshotArchive(reader: ByteReader, handlers: ArchiveReadHandlers): Promise<void> {
  await handlers.config(await readNamedEntry(reader, ARCHIVE_CONFIG_ENTRY))
  const raw = await openManifestPayload(await readNamedEntry(reader, ARCHIVE_MANIFEST_ENTRY))
  const sourceIndexName = sourceIndexNameOf(listedKeysOf(raw))
  const decoded = decodeManifestPayload(raw, sourceIndexName)
  if (decoded.kind !== 'current') invalidArchive('the manifest holds the layout of an earlier release')
  const manifest = decoded.manifest
  await handlers.manifest(manifest, sourceIndexName)

  const files = manifestFileRefs(manifest)
  const prefix = `${sourceIndexName}/`
  const listedNames = new Set(files.map(file => file.key.slice(prefix.length)))
  const seen = new Set<string>()
  for (const ref of files) {
    const expected = ref.key.slice(prefix.length)
    const header = await nextEntryHeader(reader)
    if (header === null) invalidArchive(`the archive ends before it holds "${expected}"`)
    if (header.name !== expected) {
      const why = !listedNames.has(header.name)
        ? 'that the manifest does not list'
        : seen.has(header.name)
          ? 'twice'
          : 'out of order'
      invalidArchive(`the archive holds the entry "${header.name}" ${why}`, { entry: header.name })
    }
    if (header.size !== ref.bytes) {
      invalidArchive(`the entry "${expected}" holds ${header.size} bytes where the manifest lists ${ref.bytes}`)
    }
    const bytes = await readPadded(reader, header.size)
    if (headerChecksumOf(bytes) !== ref.checksum) {
      invalidArchive(`the entry "${expected}" carries a checksum other than the manifest lists`, { entry: expected })
    }
    seen.add(expected)
    await handlers.file(expected, ref, bytes)
  }
  const trailing = await nextEntryHeader(reader)
  if (trailing !== null) {
    invalidArchive(`the archive holds the entry "${trailing.name}" that the manifest does not list`, {
      entry: trailing.name,
    })
  }
}
