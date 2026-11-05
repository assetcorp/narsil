import { ErrorCodes, NarsilError } from '../../../errors'
import type { AppendHandle, DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { crc32 } from '../../../serialization/crc32'
import { DOWNLOAD_FRAME_BYTES } from '../constants'
import type { SavedDownload } from '../types'
import { frameOf } from './frames'
import { decodeDownloadTag, downloadOutOfOrder, encodeDownloadTag } from './records'

const DOWNLOAD_TAG_KEY = 'download.tag'
const DOWNLOAD_BYTES_KEY = 'download.bin'
const FRAME_HEADER_BYTES = 8

type ReadRange = (key: string, offset: number, length: number) => Promise<Uint8Array>

interface FrameHeader {
  length: number
  checksum: number
}

async function readHeader(readRange: ReadRange, at: number): Promise<FrameHeader> {
  const header = await readRange(DOWNLOAD_BYTES_KEY, at, FRAME_HEADER_BYTES)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  return { length: view.getUint32(0, false), checksum: view.getUint32(4, false) }
}

export interface FilesystemDownload {
  append(entityTag: string, offset: number, chunk: Uint8Array): Promise<void>
  read(): SavedDownload | null
  clear(): Promise<void>
  close(): Promise<void>
}

async function scanFrames(readRange: ReadRange, onDisk: number): Promise<{ savedLength: number; fileLength: number }> {
  let savedLength = 0
  let fileLength = 0
  while (fileLength + FRAME_HEADER_BYTES <= onDisk) {
    const header = await readHeader(readRange, fileLength)
    const end = fileLength + FRAME_HEADER_BYTES + header.length
    if (header.length === 0 || header.length > DOWNLOAD_FRAME_BYTES || end > onDisk) break
    const payload = await readRange(DOWNLOAD_BYTES_KEY, fileLength + FRAME_HEADER_BYTES, header.length)
    if (crc32(payload) !== header.checksum) break
    savedLength += header.length
    fileLength = end
  }
  return { savedLength, fileLength }
}

export async function openFilesystemDownload(directory: DurableDirectory): Promise<FilesystemDownload> {
  const directoryReadRange = directory.readRange
  if (directoryReadRange === undefined) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The device sync store needs a directory that reads by position')
  }
  const readRange: ReadRange = (key, offset, length) => directoryReadRange.call(directory, key, offset, length)
  let entityTag: string | null = null
  let savedLength = 0
  let fileLength = 0
  const tagBytes = await directory.read(DOWNLOAD_TAG_KEY)
  if (tagBytes !== null) entityTag = decodeDownloadTag(tagBytes)
  if (entityTag === null) {
    await directory.remove(DOWNLOAD_BYTES_KEY)
  } else {
    const scanned = await scanFrames(readRange, (await directory.byteLength?.(DOWNLOAD_BYTES_KEY)) ?? 0)
    savedLength = scanned.savedLength
    fileLength = scanned.fileLength
  }
  let handle: AppendHandle = await directory.appendHandle(DOWNLOAD_BYTES_KEY)
  if ((await handle.size()) !== fileLength) await handle.truncate(fileLength)

  async function reset(nextTag: string | null): Promise<void> {
    await handle.close()
    await directory.remove(DOWNLOAD_BYTES_KEY)
    if (nextTag === null) {
      await directory.remove(DOWNLOAD_TAG_KEY)
    } else {
      await directory.atomicWrite(DOWNLOAD_TAG_KEY, encodeDownloadTag(nextTag))
    }
    entityTag = nextTag
    savedLength = 0
    fileLength = 0
    handle = await directory.appendHandle(DOWNLOAD_BYTES_KEY)
  }

  return {
    async append(tag, offset, chunk) {
      if (offset === 0) {
        await reset(tag)
      } else if (tag !== entityTag || offset !== savedLength) {
        throw downloadOutOfOrder(tag, offset, tag === entityTag ? savedLength : 0)
      }
      try {
        for (let at = 0; at < chunk.byteLength; at += DOWNLOAD_FRAME_BYTES) {
          await handle.append(frameOf(chunk.subarray(at, at + DOWNLOAD_FRAME_BYTES)))
        }
        await handle.sync()
      } catch (error) {
        await handle.truncate(fileLength).catch(() => undefined)
        throw error
      }
      savedLength += chunk.byteLength
      fileLength = await handle.size()
    },

    read() {
      const tag = entityTag
      if (tag === null || savedLength === 0) return null
      const framesEnd = fileLength
      return {
        entityTag: tag,
        byteLength: savedLength,
        async *chunks() {
          let at = 0
          while (at < framesEnd) {
            const header = await readHeader(readRange, at)
            yield await readRange(DOWNLOAD_BYTES_KEY, at + FRAME_HEADER_BYTES, header.length)
            at += FRAME_HEADER_BYTES + header.length
          }
        },
      }
    },

    async clear() {
      await reset(null)
    },

    async close() {
      await handle.close()
    },
  }
}
