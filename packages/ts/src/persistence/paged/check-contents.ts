import { compareCodePoints, decodeStoredDocument } from '#platform/storage-host'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { SegmentSelection } from '../../core/partition/frozen/merge'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import { MERGE_READ_CACHE_BYTES } from './constants'
import { type FileSection, ID_SAMPLE_INTERVAL, loadFailed, SMALLEST_BLOCK_POSTINGS, sectionNamed } from './format'
import { createListReader, type ListReader } from './lists'
import { createReadCache, type ReadCache } from './read-cache'
import { createRemovalReader } from './removals'
import { checkEverySectionPage, closePagedFile, createSectionReader, openPagedFile } from './section-file'
import { requirePagedPathChecksum } from './verify'

function requireIds(segment: FrozenSegment, snapshot: PagedSegmentSnapshot): void {
  const ids = segment.arrays.idTable
  let previous: string | null = null
  for (let position = 0; position < snapshot.documentCount; position++) {
    const id = ids.idAt(ids.sortedOrdinalAt(position))
    if (previous !== null && compareCodePoints(previous, id) >= 0)
      loadFailed(`The ID order of "${snapshot.key}" does not ascend at position ${position}`, { position })
    if (position % ID_SAMPLE_INTERVAL === 0 && snapshot.idSampleIds[position / ID_SAMPLE_INTERVAL] !== id)
      loadFailed(`The ID sample of "${snapshot.key}" differs at position ${position}`, { position })
    previous = id
  }
}

function requirePostings(lists: ListReader, snapshot: PagedSegmentSnapshot): void {
  const fields = snapshot.fieldNames.map(field => {
    const at = snapshot.fieldLengthNames.indexOf(field)
    return at < 0 ? null : snapshot.fieldLengthColumns[at]
  })
  for (let token = 0; token < snapshot.tokenTable.documentFrequencies.length; token++) {
    const list = lists.listAt(token)
    lists.positionsAt(token)
    const bounds = lists.storedBoundsAt(token)
    if (list.docIds.length > SMALLEST_BLOCK_POSTINGS !== (bounds !== null))
      loadFailed(`The block summaries of token ${token} of "${snapshot.key}" do not cover its postings`, { token })
    let documents = 0
    let occurrences = 0
    let block = 0
    let start = 0
    let maxFrequency = 0
    let minLength = Number.POSITIVE_INFINITY
    let maxEntries = 0
    let blockDocuments = 0
    let row = 0
    while (row < list.docIds.length) {
      const document = list.docIds[row]
      let entries = 0
      do {
        const frequency = list.termFrequencies[row]
        occurrences += frequency
        maxFrequency = Math.max(maxFrequency, frequency)
        minLength = Math.min(minLength, fields[list.fieldNameIndices[row]]?.[document] ?? 0)
        row++
        entries++
      } while (row < list.docIds.length && list.docIds[row] === document)
      documents++
      blockDocuments++
      maxEntries = Math.max(maxEntries, entries)
      if (bounds === null || (row - start < SMALLEST_BLOCK_POSTINGS && row < list.docIds.length)) continue
      if (
        block >= bounds.blockCount ||
        bounds.entryEnd[block] !== row ||
        bounds.maxTermFrequency[block] !== maxFrequency ||
        bounds.minFieldLength[block] !== minLength ||
        bounds.maxEntriesPerDocument[block] !== maxEntries ||
        bounds.documentCount[block] !== blockDocuments
      )
        loadFailed(`Block ${block} of token ${token} of "${snapshot.key}" differs from its postings`, { token, block })
      block++
      start = row
      maxFrequency = 0
      minLength = Number.POSITIVE_INFINITY
      maxEntries = 0
      blockDocuments = 0
    }
    if (documents !== snapshot.tokenTable.documentFrequencies[token] || occurrences !== lists.totalAt(token))
      loadFailed(`The counts of token ${token} of "${snapshot.key}" differ from its postings`, { token })
  }
}

export async function checkPagedContents(segment: FrozenSegment, cache: ReadCache): Promise<void> {
  const { paged } = segment
  if (paged === null) return
  const { snapshot } = paged
  for (const section of snapshot.sections) await checkEverySectionPage(snapshot.path, section, () => true)
  const file = openPagedFile(snapshot.path, cache)
  try {
    const sectionReader = (name: string) => {
      const section = sectionNamed(snapshot.sections, name)
      return section === undefined ? null : createSectionReader(file, section)
    }
    const required = (name: string) => {
      const section: FileSection | undefined = sectionNamed(snapshot.sections, name)
      if (section === undefined) loadFailed(`The segment "${snapshot.key}" holds no section "${name}"`)
      return createSectionReader(file, section)
    }
    const removals = createRemovalReader(
      file,
      required('removalOffsets'),
      required('removals'),
      segment.arrays.tokenTable.size,
    )
    for (let ordinal = 0; ordinal < snapshot.documentCount; ordinal++) {
      decodeStoredDocument(paged.encodedDocumentAt(ordinal), snapshot.discardedFields)
      paged.writeRecordAt(ordinal)
      removals(ordinal)
    }
    if (snapshot.documentCount === 0) {
      for (const name of ['idOffsets', 'removalOffsets']) {
        const offsets = required(name).bytesAt(0, 4)
        if (new DataView(offsets.buffer, offsets.byteOffset, 4).getUint32(0, true) !== 0)
          loadFailed(`Section "${name}" of "${snapshot.key}" does not start at zero`)
      }
    }
    if (snapshot.tracksPositions && snapshot.postingOffsets[snapshot.postingOffsets.length - 1] === 0) {
      const offsets = required('positionOffsets').bytesAt(0, 4)
      if (new DataView(offsets.buffer, offsets.byteOffset, 4).getUint32(0, true) !== 0)
        loadFailed(`The position offsets of "${snapshot.key}" do not start at zero`)
    }
    requireIds(segment, snapshot)
    requirePostings(createListReader(file, snapshot, sectionReader), snapshot)
    segment.arrays.readSurfaceForms()
  } finally {
    closePagedFile(file)
  }
}

export async function checkPagedSelections(selections: readonly SegmentSelection[]): Promise<void> {
  const cache = createReadCache(MERGE_READ_CACHE_BYTES)
  try {
    const checked = new Set<FrozenSegment>()
    for (const { segment } of selections) {
      if (segment.paged === null || checked.has(segment)) continue
      checked.add(segment)
      await requirePagedPathChecksum(segment.paged.snapshot.path)
      await checkPagedContents(segment, cache)
    }
  } finally {
    cache.clear()
  }
}
