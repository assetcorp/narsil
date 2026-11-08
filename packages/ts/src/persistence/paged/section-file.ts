import {
  crc32,
  createFixedBuffer,
  createVectorFileReader,
  ErrorCodes,
  HEADER_SIZE,
  NarsilError,
} from '#platform/storage-host'
import type { VectorFileReader } from '#platform/vector-file'
import type { NativePageSection } from '../../vector/native/types/paged'
import type { FileSection } from './format'
import { type NativeOpenFile, nativeSection, openNativePagedFile, requireNativePage } from './native-file'
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
  native: NativeOpenFile | null
  closed: boolean
}

const readersOfPath = new Map<string, number>()

export function cachedFileBytes(file: PagedFile): number {
  if (file.closed) return 0
  return (
    file.cache.bytesOfFile(file.fileNumber) +
    (file.native === null ? 0 : file.cache.bytesOfPageFile(file.native.handle.identity))
  )
}

export function openPagedFile(path: string, cache: ReadCache): PagedFile {
  const native = openNativePagedFile(path)
  readersOfPath.set(path, (readersOfPath.get(path) ?? 0) + 1)
  try {
    return { path, fileNumber: cache.fileNumber(), cache, native, closed: false }
  } catch (error) {
    native?.core.closePagedFile(native.handle)
    stopReadingPath(path)
    throw error
  }
}

function stopReadingPath(path: string): void {
  const readers = (readersOfPath.get(path) ?? 1) - 1
  if (readers > 0) {
    readersOfPath.set(path, readers)
    return
  }
  readersOfPath.delete(path)
  fileReaderOfThisThread().retainOnly(new Set(readersOfPath.keys()))
}

export function closePagedFile(file: PagedFile): void {
  if (file.closed) return
  file.closed = true
  if (file.native !== null) file.cache.releasePageFile(file.native.handle.identity)
  file.native?.core.closePagedFile(file.native.handle)
  file.native = null
  file.cache.releaseFile(file.fileNumber)
  stopReadingPath(file.path)
}

export function relocatePagedFile(file: PagedFile, path: string): void {
  if (path === file.path) return
  const native = openNativePagedFile(path)
  if (file.native !== null) file.cache.releasePageFile(file.native.handle.identity)
  file.native?.core.closePagedFile(file.native.handle)
  file.native = native
  stopReadingPath(file.path)
  const retained = new Set(readersOfPath.keys())
  retained.delete(path)
  fileReaderOfThisThread().retainOnly(retained)
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

export function readFileRangeLater(path: string, offset: number, target: Uint8Array): Promise<boolean> {
  return fileReaderOfThisThread().readLater(path, offset, target)
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
  readonly native: NativePageSection | null
  read(position: number, target: Uint8Array): void
  fetchRows(positions: readonly number[], rowBytes: number): Promise<unknown> | null
  bytesAt(position: number, length: number): Uint8Array
  whole(): Uint8Array
}

export function createSectionReader(file: PagedFile, section: FileSection): SectionReader {
  const { pageBytes, length } = section
  const start = HEADER_SIZE + section.offset
  const fault = new BigUint64Array(3)

  function pageAt(page: number): Uint8Array {
    const entry = start + page * pageBytes
    const held = file.cache.get<Uint8Array>(file.fileNumber, CACHED_PAGE, entry)
    if (held !== undefined) return held
    const bytes = new Uint8Array(Math.min(pageBytes, length - page * pageBytes))
    const descriptor = nativeSection(file.native, section)
    if (descriptor !== null && file.native !== null) {
      const status = file.native.core.readPage(descriptor, file.cache.pageCache(), BigInt(page), bytes, fault)
      requireNativePage(status, file.path, section.name, fault[2])
    } else {
      readFileRange(file.path, entry, bytes)
      requirePageChecksum(file.path, section, page, bytes)
    }
    file.cache.put(file.fileNumber, CACHED_PAGE, entry, bytes, bytes.byteLength)
    return bytes
  }

  async function fetchPage(page: number): Promise<void> {
    const entry = start + page * pageBytes
    const size = Math.min(pageBytes, length - page * pageBytes)
    const native = file.native
    const descriptor = nativeSection(native, section)
    const bytes = new Uint8Array(native === null ? new ArrayBuffer(size) : createFixedBuffer(size))
    if (native !== null && descriptor !== null) {
      const failure = new BigUint64Array(createFixedBuffer(3 * BigUint64Array.BYTES_PER_ELEMENT))
      const status = await native.core.readPageAsync(descriptor, null, BigInt(page), bytes, failure)
      requireNativePage(status, file.path, section.name, failure[2])
    } else {
      if (!(await fileReaderOfThisThread().readLater(file.path, entry, bytes))) unreadable(file.path, entry, bytes)
      requirePageChecksum(file.path, section, page, bytes)
    }
    if (!file.closed) file.cache.put(file.fileNumber, CACHED_PAGE, entry, bytes, bytes.byteLength)
  }

  function requireInside(position: number, size: number): void {
    if (
      !file.closed &&
      Number.isSafeInteger(position) &&
      Number.isSafeInteger(size) &&
      position >= 0 &&
      size >= 0 &&
      position <= length &&
      size <= length - position
    )
      return
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
    get native() {
      return nativeSection(file.native, section)
    },
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

export async function checkEverySectionPage(
  path: string,
  section: FileSection,
  stillWanted: () => boolean,
): Promise<void> {
  const native = openNativePagedFile(path)
  if (native !== null) {
    try {
      const descriptor = nativeSection(native, section)
      if (descriptor === null) return
      const output = new Uint8Array(createFixedBuffer(section.pageBytes))
      const failure = new BigUint64Array(createFixedBuffer(3 * BigUint64Array.BYTES_PER_ELEMENT))
      for (let page = 0; page * section.pageBytes < section.length; page++) {
        if (!stillWanted()) return
        const status = await native.core.readPageAsync(descriptor, null, BigInt(page), output, failure)
        requireNativePage(status, path, section.name, failure[2])
      }
    } finally {
      native.core.closePagedFile(native.handle)
    }
    return
  }
  const reader = fileReaderOfThisThread()
  const start = HEADER_SIZE + section.offset
  for (let page = 0; page * section.pageBytes < section.length; page++) {
    if (!stillWanted()) return
    const from = page * section.pageBytes
    const bytes = new Uint8Array(Math.min(section.pageBytes, section.length - from))
    if (!(await reader.readLater(path, start + from, bytes))) unreadable(path, start + from, bytes)
    requirePageChecksum(path, section, page, bytes)
  }
}

export function readWholeSectionChecked(path: string, section: FileSection, shared: boolean): Uint8Array {
  const target = new Uint8Array(shared ? new SharedArrayBuffer(section.length) : new ArrayBuffer(section.length))
  const native = openNativePagedFile(path)
  if (native !== null) {
    try {
      const descriptor = nativeSection(native, section)
      if (descriptor === null) return target
      const failure = new BigUint64Array(3)
      for (let page = 0; page * section.pageBytes < section.length; page++) {
        const from = page * section.pageBytes
        const to = Math.min(from + section.pageBytes, section.length)
        const status = native.core.readPage(descriptor, null, BigInt(page), target.subarray(from, to), failure)
        requireNativePage(status, path, section.name, failure[2])
      }
    } finally {
      native.core.closePagedFile(native.handle)
    }
    return target
  }
  const start = HEADER_SIZE + section.offset
  if (section.length > 0) readFileRange(path, start, target)
  for (let page = 0; page * section.pageBytes < section.length; page++) {
    const from = page * section.pageBytes
    const to = Math.min(from + section.pageBytes, section.length)
    requirePageChecksum(path, section, page, target.subarray(from, to))
  }
  return target
}
