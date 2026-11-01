import { createVectorFileReader, type VectorFileReader } from '#platform/vector-file'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32 } from '../../serialization/crc32'
import { HEADER_SIZE } from '../../serialization/header'
import type { FileSection } from './format'
import { CACHED_PAGE, type ReadCache } from './read-cache'

let threadReader: VectorFileReader | null = null

function fileReaderOfThisThread(): VectorFileReader {
  threadReader ??= createVectorFileReader()
  return threadReader
}

export interface PagedFile {
  path: string
  readonly fileNumber: number
  readonly cache: ReadCache
}

const readersOfPath = new Map<string, number>()

export function openPagedFile(path: string, cache: ReadCache): PagedFile {
  readersOfPath.set(path, (readersOfPath.get(path) ?? 0) + 1)
  return { path, fileNumber: cache.fileNumber(), cache }
}

export function closePagedFile(file: PagedFile): void {
  const readers = (readersOfPath.get(file.path) ?? 1) - 1
  if (readers > 0) {
    readersOfPath.set(file.path, readers)
    return
  }
  readersOfPath.delete(file.path)
  fileReaderOfThisThread().retainOnly(new Set(readersOfPath.keys()))
}

export function relocatePagedFile(file: PagedFile, path: string): void {
  if (path === file.path) return
  closePagedFile(file)
  readersOfPath.set(path, (readersOfPath.get(path) ?? 0) + 1)
  file.path = path
}

function unreadable(path: string, offset: number, target: Uint8Array): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The file "${path}" cannot be read at byte ${offset}`, {
    path,
    offset,
    length: target.byteLength,
  })
}

export function readFileRange(path: string, offset: number, target: Uint8Array): void {
  if (!fileReaderOfThisThread().readInto(path, offset, target)) unreadable(path, offset, target)
}

export function checksumOfPage(section: FileSection, page: number): number {
  const at = page * 4
  const { checksums } = section
  return (checksums[at] | (checksums[at + 1] << 8) | (checksums[at + 2] << 16) | (checksums[at + 3] << 24)) >>> 0
}

export function requirePageChecksum(path: string, section: FileSection, page: number, bytes: Uint8Array): void {
  if (crc32(bytes) === checksumOfPage(section, page)) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_CRC_MISMATCH,
    `Page ${page} of section "${section.name}" of the file "${path}" does not match its checksum`,
    { path, section: section.name, page },
  )
}

export interface SectionReader {
  readonly length: number
  read(position: number, target: Uint8Array): void
  fetchRows(positions: readonly number[], rowBytes: number): Promise<unknown> | null
  bytesAt(position: number, length: number): Uint8Array
  whole(): Uint8Array
}

export function createSectionReader(file: PagedFile, section: FileSection): SectionReader {
  const { pageBytes, length } = section
  const start = HEADER_SIZE + section.offset

  function pageAt(page: number): Uint8Array {
    const entry = start + page * pageBytes
    const held = file.cache.get<Uint8Array>(file.fileNumber, CACHED_PAGE, entry)
    if (held !== undefined) return held
    const bytes = new Uint8Array(Math.min(pageBytes, length - page * pageBytes))
    readFileRange(file.path, entry, bytes)
    requirePageChecksum(file.path, section, page, bytes)
    file.cache.put(file.fileNumber, CACHED_PAGE, entry, bytes, bytes.byteLength)
    return bytes
  }

  async function fetchPage(page: number): Promise<void> {
    const entry = start + page * pageBytes
    const bytes = new Uint8Array(Math.min(pageBytes, length - page * pageBytes))
    if (!(await fileReaderOfThisThread().readLater(file.path, entry, bytes))) unreadable(file.path, entry, bytes)
    requirePageChecksum(file.path, section, page, bytes)
    file.cache.put(file.fileNumber, CACHED_PAGE, entry, bytes, bytes.byteLength)
  }

  function requireInside(position: number, size: number): void {
    if (position >= 0 && position + size <= length) return
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `A read of ${size} bytes at ${position} ends outside section "${section.name}" of "${file.path}"`,
      { path: file.path, section: section.name, position, size, length },
    )
  }

  function read(position: number, target: Uint8Array): void {
    requireInside(position, target.byteLength)
    let written = 0
    while (written < target.byteLength) {
      const at = position + written
      const page = Math.floor(at / pageBytes)
      const from = at - page * pageBytes
      const bytes = pageAt(page)
      const take = Math.min(bytes.byteLength - from, target.byteLength - written)
      target.set(bytes.subarray(from, from + take), written)
      written += take
    }
  }

  return {
    length,
    read,

    fetchRows(positions: readonly number[], rowBytes: number): Promise<unknown> | null {
      const wanted = new Set<number>()
      for (const position of positions) {
        requireInside(position, rowBytes)
        const last = Math.floor((position + rowBytes - 1) / pageBytes)
        for (let page = Math.floor(position / pageBytes); page <= last; page++) {
          if (file.cache.get<Uint8Array>(file.fileNumber, CACHED_PAGE, start + page * pageBytes) === undefined) {
            wanted.add(page)
          }
        }
      }
      if (wanted.size === 0) return null
      return Promise.all(Array.from(wanted, fetchPage))
    },

    bytesAt(position: number, size: number): Uint8Array {
      requireInside(position, size)
      if (size === 0) return new Uint8Array(0)
      const page = Math.floor(position / pageBytes)
      const from = position - page * pageBytes
      if (from + size <= pageBytes) return pageAt(page).subarray(from, from + size)
      const target = new Uint8Array(size)
      read(position, target)
      return target
    },

    whole(): Uint8Array {
      const target = new Uint8Array(length)
      read(0, target)
      return target
    },
  }
}

export function readWholeSectionChecked(path: string, section: FileSection, shared: boolean): Uint8Array {
  const target = new Uint8Array(shared ? new SharedArrayBuffer(section.length) : new ArrayBuffer(section.length))
  const start = HEADER_SIZE + section.offset
  if (section.length > 0) readFileRange(path, start, target)
  for (let page = 0; page * section.pageBytes < section.length; page++) {
    const from = page * section.pageBytes
    const to = Math.min(from + section.pageBytes, section.length)
    requirePageChecksum(path, section, page, target.subarray(from, to))
  }
  return target
}
