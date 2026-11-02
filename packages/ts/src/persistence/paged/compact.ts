import { createSharedFrozenSegment, type FrozenSegment, shareSegmentArrays } from '../../core/partition/frozen'
import type { TextAnalysis } from '../../core/partition/frozen/surface-slot'
import type { PartialWordAnalysis } from '../../core/partition/partial-words/spellings'
import type { SegmentWriteRecords } from '../../serialization/keyword-segment/types'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { SegmentRef } from '../durability/segment/manifest'
import { readSegmentFile } from '../durability/segment/segment-file'
import { writeSegmentsOf } from '../durability/segment/segment-write'
import type { CheckpointStore } from '../durability/segment/store'
import { MERGE_READ_CACHE_BYTES } from './constants'
import { createPagedFrozenSegment } from './open-segment'
import { createReadCache } from './read-cache'
import { openPagedSnapshot } from './resident'
import { isPagedSegmentFile, pagedListingOf, requirePagedPayloadChecksum } from './verify'

export interface PagedWindowMerge {
  store: CheckpointStore
  directory: DurableDirectory
  indexName: string
  partitionId: number
  schema: Record<string, string>
  partialWordAnalysis: PartialWordAnalysis | null
  textAnalysis: TextAnalysis | null
  nextSegmentId: number
  refs: readonly SegmentRef[]
  dropsEveryTombstone: boolean
}

interface OpenedSource {
  segment: FrozenSegment
  replaces: string[]
  close(): void
  writeRecords?: SegmentWriteRecords
}

async function openSource(input: PagedWindowMerge, ref: SegmentRef, cache: ReturnType<typeof createReadCache>) {
  const { directory, store } = input
  if (await isPagedSegmentFile(directory, ref.key)) {
    const listing = await pagedListingOf(directory, ref)
    await requirePagedPayloadChecksum(directory, listing)
    const snapshot = openPagedSnapshot(listing)
    const segment = createPagedFrozenSegment(snapshot, cache)
    const opened: OpenedSource = {
      segment,
      replaces: snapshot.tombstones,
      close: () => segment.paged?.close(),
    }
    return opened
  }
  const contents = await readSegmentFile(store, ref)
  const segment = createSharedFrozenSegment(shareSegmentArrays(contents.arrays, null))
  const ids = segment.arrays.idTable
  const replaces = [...contents.tombstones]
  for (let ordinal = 0; ordinal < ids.count; ordinal++) replaces.push(ids.idAt(ordinal))
  const opened: OpenedSource = { segment, replaces, close: () => undefined }
  if (contents.writeRecords !== undefined) opened.writeRecords = contents.writeRecords
  return opened
}

export async function mergePagedWindow(
  input: PagedWindowMerge,
): Promise<{ segments: SegmentRef[]; nextSegmentId: number }> {
  const cache = createReadCache(MERGE_READ_CACHE_BYTES)
  const sources: OpenedSource[] = []
  try {
    for (const ref of input.refs) sources.push(await openSource(input, ref, cache))
    for (let newer = 1; newer < sources.length; newer++) {
      for (const docId of sources[newer].replaces) {
        for (let older = 0; older < newer; older++) sources[older].segment.tombstoneDocument(docId)
      }
    }
    const tombstones = new Set<string>()
    if (!input.dropsEveryTombstone) {
      for (const source of sources) {
        for (const docId of source.replaces) tombstones.add(docId)
      }
    }
    const writeRecords = new Map<FrozenSegment, SegmentWriteRecords>()
    for (const source of sources) {
      if (source.writeRecords !== undefined) writeRecords.set(source.segment, source.writeRecords)
    }
    return await writeSegmentsOf({
      store: input.store,
      indexName: input.indexName,
      partitionId: input.partitionId,
      nextSegmentId: input.nextSegmentId,
      schema: input.schema,
      partialWordAnalysis: input.partialWordAnalysis,
      textAnalysis: input.textAnalysis,
      selections: sources.map(source => ({ segment: source.segment })),
      tombstones: [...tombstones],
      mergesIntoOneFile: true,
      paged: true,
      ...(writeRecords.size === 0 ? {} : { writeRecords }),
    })
  } finally {
    for (const source of sources) source.close()
    cache.clear()
  }
}
