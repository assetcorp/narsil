import { compareCodePoints } from '../../core/ordering'
import { decodeStoredDocument } from '../../core/partition/frozen/document-source'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { SegmentManifest } from '../durability/segment/manifest'
import { MERGE_READ_CACHE_BYTES } from './constants'
import { type FileSection, loadFailed, sectionNamed } from './format'
import { createPagedFrozenSegment } from './open-segment'
import { createReadCache, type ReadCache } from './read-cache'
import { bytesOfResidentSections, openPagedSnapshot } from './resident'
import { closePagedFile, createSectionReader, openPagedFile, type SectionReader } from './section-file'
import { isPagedSegmentFile, pagedListingOf, requirePagedPayloadChecksum } from './verify'

const REMOVAL_VALUE_BYTES = 4

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
  if (paged === null) loadFailed(`The segment "${ref.key}" opened without its file`)
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

function requireIdOrderAscending(
  ids: { sortedOrdinalAt(position: number): number; idAt(ordinal: number): string },
  count: number,
  key: string,
): void {
  let previous: string | null = null
  for (let position = 0; position < count; position++) {
    const id = ids.idAt(ids.sortedOrdinalAt(position))
    if (previous !== null && compareCodePoints(previous, id) >= 0) {
      loadFailed(`The ID order of "${key}" does not ascend at position ${position}`, { position })
    }
    previous = id
  }
}

function requireRemovalEntry(
  offsets: SectionReader,
  removals: SectionReader,
  tokenCount: number,
  ordinal: number,
  key: string,
): void {
  const bounds = offsets.bytesAt(ordinal * REMOVAL_VALUE_BYTES, REMOVAL_VALUE_BYTES * 2)
  const boundsView = new DataView(bounds.buffer, bounds.byteOffset, bounds.byteLength)
  const from = boundsView.getUint32(0, true)
  const to = boundsView.getUint32(REMOVAL_VALUE_BYTES, true)
  if (to < from || to * REMOVAL_VALUE_BYTES > removals.length || from % 2 !== 0 || to % 2 !== 0) {
    loadFailed(`The removal entry of document ${ordinal} of "${key}" leaves its list`, { ordinal })
  }
  const entry = removals.bytesAt(from * REMOVAL_VALUE_BYTES, (to - from) * REMOVAL_VALUE_BYTES)
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
  for (let at = 0; at < entry.byteLength; at += REMOVAL_VALUE_BYTES * 2) {
    const token = view.getUint32(at, true)
    if (token >= tokenCount) {
      loadFailed(`The removal entry of document ${ordinal} of "${key}" lists token ${token}`, { ordinal })
    }
  }
}

function requireRemovalEntries(snapshot: PagedSegmentSnapshot, cache: ReadCache, tokenCount: number): void {
  const file = openPagedFile(snapshot.path, cache)
  try {
    const sections = snapshot.sections as FileSection[]
    const reader = (name: string): SectionReader => {
      const section = sectionNamed(sections, name)
      if (section === undefined)
        loadFailed(`The segment "${snapshot.key}" holds no section "${name}"`, { section: name })
      return createSectionReader(file, section)
    }
    const offsets = reader('removalOffsets')
    const removals = reader('removals')
    for (let ordinal = 0; ordinal < snapshot.documentCount; ordinal++) {
      requireRemovalEntry(offsets, removals, tokenCount, ordinal, snapshot.key)
    }
  } finally {
    closePagedFile(file)
  }
}

export async function checkPagedSegmentFully(
  directory: DurableDirectory,
  ref: ScannedSegmentRef,
): Promise<Readonly<Record<string, string>>> {
  const listing = await pagedListingOf(directory, ref)
  await requirePagedPayloadChecksum(directory, listing)
  const snapshot = openPagedSnapshot(listing)
  const cache = createReadCache(MERGE_READ_CACHE_BYTES)
  const segment = createPagedFrozenSegment(snapshot, cache)
  const { paged } = segment
  if (paged === null) loadFailed(`The segment "${ref.key}" opened without its file`)
  try {
    for (let ordinal = 0; ordinal < snapshot.documentCount; ordinal++) {
      decodeStoredDocument(paged.encodedDocumentAt(ordinal), snapshot.discardedFields)
    }
    requireIdOrderAscending(segment.arrays.idTable, snapshot.documentCount, ref.key)
    requireRemovalEntries(snapshot, cache, segment.arrays.tokenTable.size)
    return snapshot.schema
  } finally {
    paged.close()
    cache.clear()
  }
}

export async function bytesThatSegmentsHoldInMemory(
  directory: DurableDirectory,
  manifest: SegmentManifest,
): Promise<number> {
  let bytes = 0
  for (const partition of manifest.partitions) {
    for (const ref of partition.segments) {
      const paged = await isPagedSegmentFile(directory, ref.key)
      bytes += paged ? bytesOfResidentSections(await pagedListingOf(directory, ref)) : ref.bytes
    }
  }
  return bytes
}

export function countsAsLatestHolder(scans: readonly SegmentScan[], at: number, docId: string): boolean {
  for (let later = at + 1; later < scans.length; later++) {
    if (scans[later].tombstones.has(docId) || scans[later].holds(docId)) return false
  }
  return true
}
