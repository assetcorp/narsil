import { decodeStoredDocument } from '../../core/partition/frozen/document-source'
import type { DurableDirectory } from '../durability/durable-filesystem'
import { MERGE_READ_CACHE_BYTES } from './constants'
import { createPagedFrozenSegment } from './open-segment'
import { createReadCache } from './read-cache'
import { openPagedSnapshot } from './resident'
import { pagedListingOf, requirePagedPayloadChecksum } from './verify'

export interface SegmentScan {
  readonly count: number
  readonly schema: Readonly<Record<string, string>>
  readonly tombstones: ReadonlySet<string>
  idAt(ordinal: number): string
  holds(docId: string): boolean
  storedDocumentAt(ordinal: number): Record<string, unknown>
  close(): void
}

export interface ScannedSegmentRef {
  key: string
  bytes: number
  checksum: number
}

export async function openPagedSegmentScan(directory: DurableDirectory, ref: ScannedSegmentRef): Promise<SegmentScan> {
  const snapshot = openPagedSnapshot(await pagedListingOf(directory, ref))
  const cache = createReadCache(MERGE_READ_CACHE_BYTES)
  const segment = createPagedFrozenSegment(snapshot, cache)
  const { paged } = segment
  if (paged === null) throw new Error(`The segment "${ref.key}" opened without its file`)
  const ids = segment.arrays.idTable
  const tombstones = new Set(snapshot.tombstones)
  return {
    count: snapshot.documentCount,
    schema: snapshot.schema,
    tombstones,
    idAt: ordinal => ids.idAt(ordinal),
    holds: docId => ids.ordinalOf(docId) >= 0,
    storedDocumentAt: ordinal =>
      decodeStoredDocument(paged.encodedDocumentAt(ordinal), snapshot.discardedFields) as Record<string, unknown>,
    close: () => {
      paged.close()
      cache.clear()
    },
  }
}

export async function checkPagedSegmentFully(
  directory: DurableDirectory,
  ref: ScannedSegmentRef,
): Promise<Readonly<Record<string, string>>> {
  await requirePagedPayloadChecksum(directory, await pagedListingOf(directory, ref))
  const scan = await openPagedSegmentScan(directory, ref)
  try {
    for (let ordinal = 0; ordinal < scan.count; ordinal++) scan.storedDocumentAt(ordinal)
    return scan.schema
  } finally {
    scan.close()
  }
}

export function countsAsLatestHolder(scans: readonly SegmentScan[], at: number, docId: string): boolean {
  for (let later = at + 1; later < scans.length; later++) {
    if (scans[later].tombstones.has(docId) || scans[later].holds(docId)) return false
  }
  return true
}
