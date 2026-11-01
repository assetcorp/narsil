import { crc32 } from '../../serialization/crc32'
import type { AppendHandle, DurableDirectory } from '../durability/durable-filesystem'
import { SECTION_WRITE_BUFFER_BYTES } from './constants'
import { SEGMENT_PAGE_BYTES } from './format'

export interface FinishedSection {
  temporaryKey: string
  length: number
  checksums: Uint8Array
}

export interface SectionSink {
  readonly length: number
  write(bytes: Uint8Array): Promise<void>
  finish(): Promise<FinishedSection>
  abandon(): Promise<void>
}

export async function openSectionSink(directory: DurableDirectory, temporaryKey: string): Promise<SectionSink> {
  await directory.remove(temporaryKey)
  const handle: AppendHandle = await directory.appendHandle(temporaryKey)
  const buffer = new Uint8Array(SECTION_WRITE_BUFFER_BYTES)
  const page = new Uint8Array(SEGMENT_PAGE_BYTES)
  const checksums: number[] = []
  let buffered = 0
  let pageFilled = 0
  let length = 0
  let closed = false

  function checksumPage(): void {
    checksums.push(crc32(page.subarray(0, pageFilled)))
    pageFilled = 0
  }

  function addToPage(bytes: Uint8Array): void {
    let at = 0
    while (at < bytes.byteLength) {
      const take = Math.min(SEGMENT_PAGE_BYTES - pageFilled, bytes.byteLength - at)
      page.set(bytes.subarray(at, at + take), pageFilled)
      pageFilled += take
      at += take
      if (pageFilled === SEGMENT_PAGE_BYTES) checksumPage()
    }
  }

  async function flush(): Promise<void> {
    if (buffered === 0) return
    await handle.append(buffer.subarray(0, buffered))
    buffered = 0
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await handle.close()
  }

  return {
    get length() {
      return length
    },

    async write(bytes: Uint8Array): Promise<void> {
      addToPage(bytes)
      length += bytes.byteLength
      let at = 0
      while (at < bytes.byteLength) {
        const take = Math.min(buffer.byteLength - buffered, bytes.byteLength - at)
        buffer.set(bytes.subarray(at, at + take), buffered)
        buffered += take
        at += take
        if (buffered === buffer.byteLength) await flush()
      }
    },

    async finish(): Promise<FinishedSection> {
      await flush()
      await close()
      if (pageFilled > 0) checksumPage()
      const bytes = new Uint8Array(checksums.length * 4)
      const view = new DataView(bytes.buffer)
      for (let at = 0; at < checksums.length; at++) view.setUint32(at * 4, checksums[at], true)
      return { temporaryKey, length, checksums: bytes }
    },

    async abandon(): Promise<void> {
      await close()
      await directory.remove(temporaryKey)
    },
  }
}
