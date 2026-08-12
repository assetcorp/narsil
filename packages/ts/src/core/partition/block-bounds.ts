import type { CompactPostingList } from '../../types/internal'

const TARGET_BLOCK_ENTRIES = 128
const ABSENT_FIELD_LENGTH = 1

/**
 * Per-block summaries of one posting list, holding what a scan needs to rule a
 * whole block out without scoring any of its entries. Every value is the most
 * generous one in the block, so a score computed from them can only overstate
 * what a document in that block reaches.
 *
 * @internal
 */
export interface PostingBlockBounds {
  revision: number
  blockCount: number
  entryEnd: Int32Array
  lastDocId: Int32Array
  maxTermFrequency: Int32Array
  minFieldLength: Float64Array
  maxEntriesPerDocument: Int32Array
  documentCount: Int32Array
}

const boundsByList = new WeakMap<CompactPostingList, PostingBlockBounds>()

function fieldLengthOf(columns: ReadonlyArray<Uint32Array | null>, fieldIndex: number, internalId: number): number {
  const column = fieldIndex < columns.length ? columns[fieldIndex] : null
  if (column === null || internalId >= column.length) return ABSENT_FIELD_LENGTH
  const stored = column[internalId]
  return stored > 0 ? stored : ABSENT_FIELD_LENGTH
}

function build(list: CompactPostingList, columns: ReadonlyArray<Uint32Array | null>): PostingBlockBounds {
  const upperBlockCount = Math.max(1, Math.ceil(list.length / TARGET_BLOCK_ENTRIES) + 1)
  const entryEnd = new Int32Array(upperBlockCount)
  const lastDocId = new Int32Array(upperBlockCount)
  const maxTermFrequency = new Int32Array(upperBlockCount)
  const minFieldLength = new Float64Array(upperBlockCount)
  const maxEntriesPerDocument = new Int32Array(upperBlockCount)
  const documentCount = new Int32Array(upperBlockCount)

  let blockIndex = 0
  let blockStart = 0
  let blockMaxTf = 0
  let blockMinLen = Number.POSITIVE_INFINITY
  let blockMaxRun = 0
  let blockDocs = 0

  let entry = 0
  while (entry < list.length) {
    const docId = list.docIds[entry]
    let run = 0
    while (entry + run < list.length && list.docIds[entry + run] === docId) {
      const position = entry + run
      const termFrequency = list.termFrequencies[position]
      if (termFrequency > blockMaxTf) blockMaxTf = termFrequency
      const fieldLength = fieldLengthOf(columns, list.fieldNameIndices[position], docId)
      if (fieldLength < blockMinLen) blockMinLen = fieldLength
      run++
    }
    if (run > blockMaxRun) blockMaxRun = run
    blockDocs++
    entry += run

    if (entry - blockStart >= TARGET_BLOCK_ENTRIES || entry === list.length) {
      entryEnd[blockIndex] = entry
      lastDocId[blockIndex] = docId
      maxTermFrequency[blockIndex] = blockMaxTf
      minFieldLength[blockIndex] = blockMinLen === Number.POSITIVE_INFINITY ? ABSENT_FIELD_LENGTH : blockMinLen
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
    revision: list.revision,
    blockCount: blockIndex,
    entryEnd,
    lastDocId,
    maxTermFrequency,
    minFieldLength,
    maxEntriesPerDocument,
    documentCount,
  }
}

/**
 * Returns the block summaries for a posting list, rebuilding them where the
 * list has changed since they were last built.
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
  if (existing !== undefined && existing.revision === list.revision) return existing
  const built = build(list, columns)
  boundsByList.set(list, built)
  return built
}
