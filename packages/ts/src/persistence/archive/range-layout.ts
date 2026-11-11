import { ErrorCodes, NarsilError } from '#platform/storage-host'
import { ARCHIVE_ENTRY_ESTIMATE_BYTES, ARCHIVE_FILE_CHUNK_BYTES } from './constants'
import { ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY } from './read'
import { tarEnd, tarEntryHeaders, tarPadding } from './tar'

export interface ArchiveFileEntry {
  name: string
  bytes: number
  read(offset: number, length: number): Promise<Uint8Array>
}

type ArchivePart =
  | { start: number; length: number; inline: Uint8Array }
  | { start: number; length: number; file: ArchiveFileEntry }

export interface ArchiveLayout {
  parts: readonly ArchivePart[]
  byteLength: number
}

export function archiveLayout(
  config: Uint8Array,
  manifestBytes: Uint8Array,
  files: readonly ArchiveFileEntry[],
): ArchiveLayout {
  const parts: ArchivePart[] = []
  let at = 0
  const inline = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return
    parts.push({ start: at, length: bytes.byteLength, inline: bytes })
    at += bytes.byteLength
  }
  for (const [name, bytes] of [
    [ARCHIVE_CONFIG_ENTRY, config],
    [ARCHIVE_MANIFEST_ENTRY, manifestBytes],
  ] as const) {
    for (const header of tarEntryHeaders(name, bytes.byteLength)) inline(header)
    inline(bytes)
    inline(tarPadding(bytes.byteLength))
  }
  for (const file of files) {
    for (const header of tarEntryHeaders(file.name, file.bytes)) inline(header)
    if (file.bytes > 0) {
      parts.push({ start: at, length: file.bytes, file })
      at += file.bytes
    }
    inline(tarPadding(file.bytes))
  }
  inline(tarEnd())
  return { parts, byteLength: at }
}

export function estimatedArchiveBytes(files: Iterable<{ bytes: number }>): number {
  let total = 0
  for (const file of files) total += file.bytes + ARCHIVE_ENTRY_ESTIMATE_BYTES
  return total
}

function firstPartAt(parts: readonly ArchivePart[], offset: number): number {
  let low = 0
  let high = parts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >>> 1
    if (parts[middle].start <= offset) low = middle
    else high = middle - 1
  }
  return low
}

export async function* archiveRange(
  layout: ArchiveLayout,
  start: number,
  endExclusive: number,
): AsyncGenerator<Uint8Array> {
  const end = Math.min(endExclusive, layout.byteLength)
  if (start >= end) return
  for (let index = firstPartAt(layout.parts, start); index < layout.parts.length; index++) {
    const part = layout.parts[index]
    if (part.start >= end) return
    const from = Math.max(start, part.start) - part.start
    const to = Math.min(end, part.start + part.length) - part.start
    if ('inline' in part) {
      yield part.inline.subarray(from, to)
      continue
    }
    for (let offset = from; offset < to; offset += ARCHIVE_FILE_CHUNK_BYTES) {
      const length = Math.min(ARCHIVE_FILE_CHUNK_BYTES, to - offset)
      const bytes = await part.file.read(offset, length)
      if (bytes.byteLength !== length) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `The archive file "${part.file.name}" ends before the bytes that its manifest lists`,
          { name: part.file.name, offset, length },
        )
      }
      yield bytes
    }
  }
}
