import type { PostingBlockBounds } from '../../core/partition/block-bounds'
import type { PagedPositions, PagedPostingList } from '../../core/partition/frozen'
import type { FrozenLiveCounts } from '../../core/partition/frozen/live-counts'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { FrozenPostingViews } from '../../core/partition/frozen/posting-views'
import type { FrozenTombstones } from '../../core/partition/frozen/tombstones'
import type { PostingListView } from '../../types/internal'
import { LIST_VIEWS_HELD_PER_SEGMENT } from './constants'
import { BLOCK_SUMMARY_BYTES, loadFailed, POSITION_WIDTH_BYTES, POSTING_WIDTH_BYTES } from './format'
import { CACHED_LIST, CACHED_POSITIONS } from './read-cache'
import type { PagedFile, SectionReader } from './section-file'

const LITTLE_ENDIAN_PLATFORM = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

function swappedInPlace(bytes: Uint8Array, width: number): void {
  for (let at = 0; at + width <= bytes.length; at += width) {
    for (let low = 0, high = width - 1; low < high; low++, high--) {
      const held = bytes[at + low]
      bytes[at + low] = bytes[at + high]
      bytes[at + high] = held
    }
  }
}

function fromLittleEndian(bytes: Uint8Array, width: number): void {
  if (!LITTLE_ENDIAN_PLATFORM) swappedInPlace(bytes, width)
}

export interface ListReader {
  listAt(token: number): PagedPostingList
  positionsAt(token: number): PagedPositions | null
  totalAt(token: number): number
  storedBoundsAt(token: number): PostingBlockBounds | null
}

function requireListRules(list: PagedPostingList, snapshot: PagedSegmentSnapshot, token: number): void {
  const { docIds, fieldNameIndices } = list
  const documents = snapshot.documentCount
  const fields = snapshot.fieldNames.length
  for (let row = 0; row < docIds.length; row++) {
    if (docIds[row] >= documents) {
      loadFailed(`Token ${token} of "${snapshot.key}" names document ${docIds[row]} of ${documents}`, { token, row })
    }
    if (fieldNameIndices[row] >= fields) {
      loadFailed(`Token ${token} of "${snapshot.key}" names field ${fieldNameIndices[row]} of ${fields}`, {
        token,
        row,
      })
    }
    if (row === 0) continue
    const before = docIds[row - 1]
    if (docIds[row] < before || (docIds[row] === before && fieldNameIndices[row] <= fieldNameIndices[row - 1])) {
      loadFailed(`The list of token ${token} of "${snapshot.key}" descends at posting ${row}`, { token, row })
    }
  }
}

export function createListReader(
  file: PagedFile,
  snapshot: PagedSegmentSnapshot,
  sectionReader: (name: string) => SectionReader | null,
): ListReader {
  const { postingOffsets } = snapshot
  const postings = sectionReader('postings')
  const positionOffsets = sectionReader('positionOffsets')
  const positions = sectionReader('positions')
  const totals = sectionReader('tokenTotals')
  const { cache, fileNumber } = file

  function listAt(token: number): PagedPostingList {
    const held = cache.get<PagedPostingList>(fileNumber, CACHED_LIST, token)
    if (held !== undefined) return held
    if (postings === null) return loadFailed(`The segment "${snapshot.key}" holds no postings`)
    const start = postingOffsets[token]
    const count = postingOffsets[token + 1] - start
    const buffer = new ArrayBuffer(count * POSTING_WIDTH_BYTES)
    const bytes = new Uint8Array(buffer)
    postings.read(start * POSTING_WIDTH_BYTES, bytes)
    if (!LITTLE_ENDIAN_PLATFORM) {
      swappedInPlace(bytes.subarray(0, count * 4), 4)
      swappedInPlace(bytes.subarray(count * 4), 2)
    }
    const list: PagedPostingList = {
      docIds: new Uint32Array(buffer, 0, count),
      termFrequencies: new Uint16Array(buffer, count * 4, count),
      fieldNameIndices: new Uint16Array(buffer, count * 6, count),
    }
    requireListRules(list, snapshot, token)
    cache.put(fileNumber, CACHED_LIST, token, list, buffer.byteLength)
    return list
  }

  function positionsAt(token: number): PagedPositions | null {
    if (positionOffsets === null || positions === null) return null
    const held = cache.get<PagedPositions>(fileNumber, CACHED_POSITIONS, token)
    if (held !== undefined) return held
    const start = postingOffsets[token]
    const count = postingOffsets[token + 1] - start
    const offsetBytes = new Uint8Array((count + 1) * POSITION_WIDTH_BYTES)
    positionOffsets.read(start * POSITION_WIDTH_BYTES, offsetBytes)
    fromLittleEndian(offsetBytes, POSITION_WIDTH_BYTES)
    const absolute = new Uint32Array(offsetBytes.buffer)
    const first = absolute[0]
    const end = absolute[count]
    const offsets = new Uint32Array(count + 1)
    for (let row = 0; row <= count; row++) {
      if (absolute[row] < first || absolute[row] > end || (row > 0 && absolute[row] < absolute[row - 1])) {
        loadFailed(`The position offsets of token ${token} of "${snapshot.key}" leave their list`, { token, row })
      }
      offsets[row] = absolute[row] - first
    }
    const valueBytes = new Uint8Array((end - first) * POSITION_WIDTH_BYTES)
    positions.read(first * POSITION_WIDTH_BYTES, valueBytes)
    fromLittleEndian(valueBytes, POSITION_WIDTH_BYTES)
    const loaded: PagedPositions = { offsets, values: new Uint32Array(valueBytes.buffer) }
    cache.put(fileNumber, CACHED_POSITIONS, token, loaded, offsetBytes.byteLength + valueBytes.byteLength)
    return loaded
  }

  function totalAt(token: number): number {
    if (totals === null) return loadFailed(`The segment "${snapshot.key}" holds no token totals`)
    const bytes = totals.bytesAt(token * 8, 8)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
  }

  function listedIndexOf(token: number): number {
    const { blockLists } = snapshot
    let low = 0
    let high = blockLists.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (blockLists[middle] < token) low = middle + 1
      else high = middle
    }
    return low < blockLists.length && blockLists[low] === token ? low : -1
  }

  function storedBoundsAt(token: number): PostingBlockBounds | null {
    const listed = listedIndexOf(token)
    if (listed < 0) return null
    const first = snapshot.blockListOffsets[listed]
    const blockCount = snapshot.blockListOffsets[listed + 1] - first
    const { blockSummaries } = snapshot
    const view = new DataView(blockSummaries.buffer, blockSummaries.byteOffset, blockSummaries.byteLength)
    const bounds: PostingBlockBounds = {
      structureRevision: 0,
      blockCount,
      entryEnd: new Int32Array(blockCount),
      maxTermFrequency: new Int32Array(blockCount),
      minFieldLength: new Float64Array(blockCount),
      maxEntriesPerDocument: new Int32Array(blockCount),
      documentCount: new Int32Array(blockCount),
    }
    const length = postingOffsets[token + 1] - postingOffsets[token]
    for (let block = 0; block < blockCount; block++) {
      const place = (first + block) * BLOCK_SUMMARY_BYTES
      bounds.entryEnd[block] = view.getUint32(place, true)
      bounds.maxTermFrequency[block] = view.getUint16(place + 4, true)
      bounds.minFieldLength[block] = view.getFloat64(place + 6, true)
      bounds.maxEntriesPerDocument[block] = view.getUint32(place + 14, true)
      bounds.documentCount[block] = view.getUint32(place + 18, true)
      const before = block === 0 ? 0 : bounds.entryEnd[block - 1]
      if (bounds.entryEnd[block] <= before || bounds.entryEnd[block] > length) {
        loadFailed(`Block ${block} of token ${token} of "${snapshot.key}" ends outside its list`, { token, block })
      }
    }
    if (blockCount === 0 || bounds.entryEnd[blockCount - 1] !== length) {
      loadFailed(`The blocks of token ${token} of "${snapshot.key}" fail to cover its list`, { token })
    }
    return bounds
  }

  return { listAt, positionsAt, totalAt, storedBoundsAt }
}

export function createPagedPostingViews(
  snapshot: PagedSegmentSnapshot,
  lists: ListReader,
  tombstones: FrozenTombstones,
  counts: FrozenLiveCounts,
): FrozenPostingViews {
  const { postingOffsets, tracksPositions } = snapshot
  const views = new Map<number, PostingListView>()

  function buildView(token: number): PostingListView {
    const length = postingOffsets[token + 1] - postingOffsets[token]
    return {
      length,
      get docIds() {
        return lists.listAt(token).docIds
      },
      get termFrequencies() {
        return lists.listAt(token).termFrequencies
      },
      get fieldNameIndices() {
        return lists.listAt(token).fieldNameIndices
      },
      get positions(): ReadonlyArray<readonly number[]> | null {
        const loaded = lists.positionsAt(token)
        if (loaded === null) return null
        const rows: Array<readonly number[]> = new Array(length)
        for (let row = 0; row < length; row++) {
          rows[row] = [...loaded.values.subarray(loaded.offsets[row], loaded.offsets[row + 1])]
        }
        return rows
      },
      holdsPositions: tracksPositions,
      positionCountAt(row: number): number {
        const loaded = lists.positionsAt(token)
        return loaded === null ? 0 : loaded.offsets[row + 1] - loaded.offsets[row]
      },
      get positionStore() {
        return lists.positionsAt(token)?.values ?? null
      },
      positionStartAt(row: number): number {
        return lists.positionsAt(token)?.offsets[row] ?? 0
      },
      docIdSet: {
        get size(): number {
          return counts.documentFrequency(token)
        },
      },
      deletedDocs: tombstones,
      get totalTermFrequency(): number {
        return lists.totalAt(token) - counts.removedOccurrences(token)
      },
      get structureRevision() {
        return tombstones.revision
      },
      ordered: true,
      storedBlockBounds(): PostingBlockBounds | null {
        return tombstones.size === 0 ? lists.storedBoundsAt(token) : null
      },
    }
  }

  return {
    viewAt(payloadSlot: number): PostingListView {
      let view = views.get(payloadSlot)
      if (view === undefined) {
        if (views.size >= LIST_VIEWS_HELD_PER_SEGMENT) views.clear()
        view = buildView(payloadSlot)
        views.set(payloadSlot, view)
      }
      return view
    },

    viewReadOnce(payloadSlot: number): PostingListView {
      return buildView(payloadSlot)
    },
  }
}
