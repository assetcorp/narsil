import type { CompactPostingList } from '../../types/internal'

const TARGET_BLOCK_ENTRIES = 128
const ABSENT_FIELD_LENGTH_BOUND = 0

/**
 * Per-block summaries of one posting list, holding what a scan needs to rule a
 * whole block out without scoring any of its entries. Every value is the most
 * generous one among the block's live documents, so a score computed from them
 * can only overstate what a live document in that block reaches, and
 * `documentCount` excludes tombstoned documents so a ruled-out block adds the
 * exact number of matches it holds.
 *
 * @internal
 */
export interface PostingBlockBounds {
  structureRevision: number
  blockCount: number
  entryEnd: Int32Array
  maxTermFrequency: Int32Array
  minFieldLength: Float64Array
  maxEntriesPerDocument: Int32Array
  documentCount: Int32Array
}

const boundsByList = new WeakMap<CompactPostingList, PostingBlockBounds>()

function fieldLengthBound(columns: ReadonlyArray<Uint32Array | null>, fieldIndex: number, internalId: number): number {
  const column = fieldIndex < columns.length ? columns[fieldIndex] : null
  if (column === null || internalId >= column.length) return ABSENT_FIELD_LENGTH_BOUND
  const stored = column[internalId]
  return stored > 0 ? stored : ABSENT_FIELD_LENGTH_BOUND
}

function entriesCovered(bounds: PostingBlockBounds): number {
  return bounds.blockCount === 0 ? 0 : bounds.entryEnd[bounds.blockCount - 1]
}

function scan(
  list: CompactPostingList,
  columns: ReadonlyArray<Uint32Array | null>,
  previous: PostingBlockBounds | null,
  keepBlocks: number,
): PostingBlockBounds {
  const startEntry = previous !== null && keepBlocks > 0 ? previous.entryEnd[keepBlocks - 1] : 0
  const capacity = keepBlocks + Math.ceil((list.length - startEntry) / TARGET_BLOCK_ENTRIES) + 1
  const entryEnd = new Int32Array(capacity)
  const maxTermFrequency = new Int32Array(capacity)
  const minFieldLength = new Float64Array(capacity)
  const maxEntriesPerDocument = new Int32Array(capacity)
  const documentCount = new Int32Array(capacity)

  if (previous !== null && keepBlocks > 0) {
    entryEnd.set(previous.entryEnd.subarray(0, keepBlocks))
    maxTermFrequency.set(previous.maxTermFrequency.subarray(0, keepBlocks))
    minFieldLength.set(previous.minFieldLength.subarray(0, keepBlocks))
    maxEntriesPerDocument.set(previous.maxEntriesPerDocument.subarray(0, keepBlocks))
    documentCount.set(previous.documentCount.subarray(0, keepBlocks))
  }

  const deleted = list.deletedDocs
  const hasDeleted = deleted.size > 0

  let blockIndex = keepBlocks
  let blockStart = startEntry
  let blockMaxTf = 0
  let blockMinLen = Number.POSITIVE_INFINITY
  let blockMaxRun = 0
  let blockDocs = 0

  let entry = startEntry
  while (entry < list.length) {
    const docId = list.docIds[entry]
    const tombstoned = hasDeleted && deleted.has(docId)
    let run = 0
    while (entry + run < list.length && list.docIds[entry + run] === docId) {
      if (!tombstoned) {
        const position = entry + run
        const termFrequency = list.termFrequencies[position]
        if (termFrequency > blockMaxTf) blockMaxTf = termFrequency
        const fieldLength = fieldLengthBound(columns, list.fieldNameIndices[position], docId)
        if (fieldLength < blockMinLen) blockMinLen = fieldLength
      }
      run++
    }
    if (!tombstoned) {
      if (run > blockMaxRun) blockMaxRun = run
      blockDocs++
    }
    entry += run

    if (entry - blockStart >= TARGET_BLOCK_ENTRIES || entry === list.length) {
      entryEnd[blockIndex] = entry
      maxTermFrequency[blockIndex] = blockMaxTf
      minFieldLength[blockIndex] = blockMinLen === Number.POSITIVE_INFINITY ? ABSENT_FIELD_LENGTH_BOUND : blockMinLen
      maxEntriesPerDocument[blockIndex] = blockMaxRun
      documentCount[blockIndex] = blockDocs
      blockIndex++
      blockStart = entry
      blockMaxTf = 0
      blockMinLen = Number.POSITIVE_INFINITY
      blockMaxRun = 0
      blockDocs = 0
    }
  }

  return {
    structureRevision: list.structureRevision,
    blockCount: blockIndex,
    entryEnd,
    maxTermFrequency,
    minFieldLength,
    maxEntriesPerDocument,
    documentCount,
  }
}

/**
 * Returns the block summaries for a posting list. Summaries built earlier stay
 * valid until the list's structure changes, because an append never rewrites
 * an existing entry, so new entries extend the summaries by reopening only the
 * final block, while a tombstone or a compaction forces a full rebuild.
 *
 * @param list - The posting list to summarise.
 * @param columns - The field length columns, indexed by field name index.
 * @returns The summaries, covering every entry in the list.
 */
export function blockBoundsFor(
  list: CompactPostingList,
  columns: ReadonlyArray<Uint32Array | null>,
): PostingBlockBounds {
  const existing = boundsByList.get(list)
  if (existing !== undefined && existing.structureRevision === list.structureRevision) {
    const covered = entriesCovered(existing)
    if (covered === list.length) return existing
    if (list.ordered && covered < list.length) {
      const extended = scan(list, columns, existing, Math.max(0, existing.blockCount - 1))
      boundsByList.set(list, extended)
      return extended
    }
  }
  const built = scan(list, columns, null, 0)
  boundsByList.set(list, built)
  return built
}
