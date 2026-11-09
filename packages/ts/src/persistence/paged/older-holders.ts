import type { FrozenSegment } from '../../core/partition/frozen'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { SegmentRef } from '../durability/segment/manifest'
import { MERGE_READ_CACHE_BYTES } from './constants'
import { loadFailed, sectionNamed } from './format'
import { createPagedIdTable } from './ids'
import { createReadCache } from './read-cache'
import { readIdSampleOf, readPagedHead } from './resident'
import { closePagedFile, createSectionReader, openPagedFile } from './section-file'
import { isPagedSegmentFile, pagedListingOf } from './verify'

function everyDocumentId(segments: readonly FrozenSegment[]): string[] {
  const ids: string[] = []
  for (const segment of segments) {
    const table = segment.arrays.idTable
    for (let ordinal = 0; ordinal < table.count; ordinal++) ids.push(table.idAt(ordinal))
  }
  return ids
}

export async function pagedTombstonesFor(
  directory: DurableDirectory,
  older: readonly SegmentRef[],
  written: readonly FrozenSegment[],
  deleted: readonly string[],
): Promise<string[]> {
  const tombstones = new Set(deleted)
  if (older.length === 0) return [...tombstones]
  const ids = everyDocumentId(written)
  for (const ref of older) {
    if (!(await isPagedSegmentFile(directory, ref.key))) return [...new Set([...deleted, ...ids])]
  }
  const cache = createReadCache(MERGE_READ_CACHE_BYTES)
  try {
    for (const ref of older) {
      const listing = await pagedListingOf(directory, ref)
      const { head } = readPagedHead(listing)
      const sample = readIdSampleOf(listing.path, head)
      const file = openPagedFile(listing.path, cache)
      try {
        const reader = (name: string) => {
          const section = sectionNamed(head.sections, name)
          if (section === undefined) loadFailed(`The segment "${ref.key}" holds no section "${name}"`)
          return createSectionReader(file, section)
        }
        const table = createPagedIdTable(
          {
            documentCount: head.documentCount,
            key: ref.key,
            idSampleIds: sample.ids,
            idSamplePositions: sample.positions,
          },
          reader('ids'),
          reader('idOffsets'),
          reader('idOrder'),
        )
        for (const docId of ids) {
          if (!tombstones.has(docId) && table.ordinalOf(docId) >= 0) tombstones.add(docId)
        }
      } finally {
        closePagedFile(file)
      }
    }
  } finally {
    cache.clear()
  }
  return [...tombstones]
}
