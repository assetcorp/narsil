import { inflateBlock } from '#platform/raw-deflate'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import { endOfValue } from '../../serialization/msgpack-without-fields'
import { DOCUMENT_BLOCK_BYTES, loadFailed, MAX_DOCUMENT_BLOCK_RAW_BYTES } from './format'
import { CACHED_DOCUMENT_BLOCK, type ReadCache } from './read-cache'
import type { SectionReader } from './section-file'

interface LoadedBlock {
  bytes: Uint8Array
  starts: Uint32Array
}

export interface DocumentBlockReader {
  encodedDocumentAt(ordinal: number): Uint8Array
}

export function createDocumentBlockReader(
  snapshot: PagedSegmentSnapshot,
  documents: SectionReader,
  cache: ReadCache,
  fileNumber: number,
): DocumentBlockReader {
  const { documentBlocks, documentCount, key } = snapshot
  const view = new DataView(documentBlocks.buffer, documentBlocks.byteOffset, documentBlocks.byteLength)
  const blockCount = documentBlocks.byteLength / DOCUMENT_BLOCK_BYTES

  function firstOrdinalOf(block: number): number {
    return view.getUint32(block * DOCUMENT_BLOCK_BYTES, true)
  }

  function blockOf(ordinal: number): number {
    let low = 0
    let high = blockCount
    while (high - low > 1) {
      const middle = (low + high) >>> 1
      if (firstOrdinalOf(middle) <= ordinal) low = middle
      else high = middle
    }
    return low
  }

  function inflate(block: number): Uint8Array {
    const place = block * DOCUMENT_BLOCK_BYTES
    const offset = Number(view.getBigUint64(place + 4, true))
    const length = view.getUint32(place + 12, true)
    const rawLength = view.getUint32(place + 16, true)
    if (rawLength > MAX_DOCUMENT_BLOCK_RAW_BYTES) {
      loadFailed(`Document block ${block} of "${key}" claims ${rawLength} bytes`, { block, rawLength })
    }
    const compressed = documents.bytesAt(offset, length)
    let raw: Uint8Array
    try {
      raw = inflateBlock(compressed, rawLength)
    } catch (error) {
      return loadFailed(
        `Document block ${block} of "${key}" fails to inflate: ${error instanceof Error ? error.message : String(error)}`,
        { block },
      )
    }
    if (raw.byteLength !== rawLength) {
      loadFailed(`Document block ${block} of "${key}" inflates to ${raw.byteLength} bytes of ${rawLength}`, { block })
    }
    return raw
  }

  function startsOf(block: number, raw: Uint8Array): Uint32Array {
    const first = firstOrdinalOf(block)
    const end = block + 1 < blockCount ? firstOrdinalOf(block + 1) : documentCount
    const starts = new Uint32Array(end - first + 1)
    const bytes = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    let cursor = 0
    for (let at = 0; at < end - first; at++) {
      starts[at] = cursor
      const next = cursor < raw.byteLength ? endOfValue(bytes, cursor) : null
      if (next === null)
        loadFailed(`Document block ${block} of "${key}" holds a broken document at ${at}`, { block, at })
      cursor = next
    }
    starts[end - first] = cursor
    if (cursor !== raw.byteLength)
      loadFailed(`Document block ${block} of "${key}" holds bytes past its documents`, { block })
    return starts
  }

  function loadBlock(block: number): LoadedBlock {
    const held = cache.get<LoadedBlock>(fileNumber, CACHED_DOCUMENT_BLOCK, block)
    if (held !== undefined) return held
    const bytes = inflate(block)
    const loaded: LoadedBlock = { bytes, starts: startsOf(block, bytes) }
    cache.put(fileNumber, CACHED_DOCUMENT_BLOCK, block, loaded, bytes.byteLength + loaded.starts.byteLength)
    return loaded
  }

  return {
    encodedDocumentAt(ordinal: number): Uint8Array {
      if (ordinal < 0 || ordinal >= documentCount) {
        loadFailed(`Document ${ordinal} lies outside "${key}", which holds ${documentCount}`, { ordinal })
      }
      const block = blockOf(ordinal)
      const { bytes, starts } = loadBlock(block)
      const row = ordinal - firstOrdinalOf(block)
      return bytes.subarray(starts[row], starts[row + 1])
    },
  }
}
