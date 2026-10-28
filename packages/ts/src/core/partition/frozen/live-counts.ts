import { readResidentMemory } from '#platform/process-limit'
import { FROZEN_REMOVAL_INDEX_MAX_PROCESS_FRACTION } from '../constants'
import type { SegmentColumns } from './columns'
import type { FrozenTokenTable } from './token-table'
import type { FrozenTombstones } from './tombstones'

type CountedColumns = Pick<
  SegmentColumns,
  | 'documentCount'
  | 'postingOffsets'
  | 'postingDocIds'
  | 'postingFrequencies'
  | 'fieldLengthNames'
  | 'fieldLengthColumns'
  | 'totalFieldLengths'
>

export interface FrozenLiveCounts {
  totalDocuments(): number
  totalFieldLengths(): Readonly<Record<string, number>>
  documentFrequency(sortedIndex: number): number
  removedOccurrences(sortedIndex: number): number
  docFrequencies(): Readonly<Record<string, number>>
  subtractRemoved(ordinal: number): void
  bytes(): number
}

interface RemovalIndex {
  starts: Uint32Array
  rows: Uint32Array
  termOfSlot: Uint32Array
  documents: Uint32Array
  occurrences: Float64Array
}

const UINT32_BYTES = 4
const FLOAT64_BYTES = 8

function removalIndexBytes(columns: CountedColumns, terms: number): number {
  const documentWords = 2 * (columns.documentCount + 1)
  return (columns.postingDocIds.length + documentWords + 2 * terms) * UINT32_BYTES + terms * FLOAT64_BYTES
}

function processHasRoomFor(bytes: number): boolean {
  const memory = readResidentMemory()
  if (memory === null) return true
  return memory.residentBytes + bytes <= FROZEN_REMOVAL_INDEX_MAX_PROCESS_FRACTION * memory.limitBytes
}

function buildRemovalIndex(columns: CountedColumns, table: FrozenTokenTable): RemovalIndex {
  const { documentCount, postingDocIds } = columns
  const starts = new Uint32Array(documentCount + 1)
  for (let row = 0; row < postingDocIds.length; row++) starts[postingDocIds[row] + 1]++
  for (let ordinal = 0; ordinal < documentCount; ordinal++) starts[ordinal + 1] += starts[ordinal]
  const cursors = starts.slice(0, documentCount)
  const rows = new Uint32Array(postingDocIds.length)
  for (let row = 0; row < postingDocIds.length; row++) rows[cursors[postingDocIds[row]]++] = row
  const termOfSlot = new Uint32Array(table.size)
  for (let sortedIndex = 0; sortedIndex < table.size; sortedIndex++) {
    termOfSlot[table.payloadSlot(sortedIndex)] = sortedIndex
  }
  return {
    starts,
    rows,
    termOfSlot,
    documents: new Uint32Array(table.size),
    occurrences: new Float64Array(table.size),
  }
}

function tryBuildRemovalIndex(columns: CountedColumns, table: FrozenTokenTable): RemovalIndex | null {
  if (!processHasRoomFor(removalIndexBytes(columns, table.size))) return null
  try {
    return buildRemovalIndex(columns, table)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

function slotOfRow(postingOffsets: Uint32Array, slots: number, row: number): number {
  let low = 0
  let high = slots
  while (low < high) {
    const middle = (low + high) >>> 1
    if (postingOffsets[middle + 1] <= row) low = middle + 1
    else high = middle
  }
  return low
}

export function createFrozenLiveCounts(
  columns: CountedColumns,
  table: FrozenTokenTable,
  tombstones: FrozenTombstones,
  storedFrequencies: () => Readonly<Record<string, number>>,
): FrozenLiveCounts {
  const { postingOffsets, postingDocIds, postingFrequencies } = columns
  let index: RemovalIndex | null = null
  let lengths: Record<string, number> | null = null
  let frequencies: Readonly<Record<string, number>> | null = null
  let frequenciesRevision = -1

  function countRemoval(built: RemovalIndex, ordinal: number): void {
    const { starts, rows, termOfSlot, documents, occurrences } = built
    let previousSlot = -1
    for (let at = starts[ordinal]; at < starts[ordinal + 1]; at++) {
      const row = rows[at]
      const slot = slotOfRow(postingOffsets, table.size, row)
      const sortedIndex = termOfSlot[slot]
      if (slot !== previousSlot) documents[sortedIndex]++
      occurrences[sortedIndex] += postingFrequencies[row]
      previousSlot = slot
    }
  }

  function removedDocumentsOf(sortedIndex: number): number {
    const slot = table.payloadSlot(sortedIndex)
    const end = postingOffsets[slot + 1]
    let removed = 0
    let previous = -1
    let ordered = true
    for (let row = postingOffsets[slot]; row < end; row++) {
      const ordinal = postingDocIds[row]
      if (ordinal < previous) ordered = false
      if (ordinal !== previous && tombstones.has(ordinal)) removed++
      previous = ordinal
    }
    if (ordered) return removed
    const seen = new Set<number>()
    for (let row = postingOffsets[slot]; row < end; row++) {
      const ordinal = postingDocIds[row]
      if (tombstones.has(ordinal)) seen.add(ordinal)
    }
    return seen.size
  }

  function removedOccurrencesOf(sortedIndex: number): number {
    const slot = table.payloadSlot(sortedIndex)
    const end = postingOffsets[slot + 1]
    let removed = 0
    for (let row = postingOffsets[slot]; row < end; row++) {
      if (tombstones.has(postingDocIds[row])) removed += postingFrequencies[row]
    }
    return removed
  }

  function documentFrequency(sortedIndex: number): number {
    const stored = table.documentFrequencyAt(sortedIndex)
    if (tombstones.size === 0) return stored
    if (index !== null) return stored - index.documents[sortedIndex]
    return stored - removedDocumentsOf(sortedIndex)
  }

  return {
    totalDocuments(): number {
      return columns.documentCount - tombstones.size
    },

    totalFieldLengths(): Readonly<Record<string, number>> {
      return lengths ?? columns.totalFieldLengths
    },

    documentFrequency,

    removedOccurrences(sortedIndex: number): number {
      if (tombstones.size === 0) return 0
      if (index !== null) return index.occurrences[sortedIndex]
      return removedOccurrencesOf(sortedIndex)
    },

    docFrequencies(): Readonly<Record<string, number>> {
      if (tombstones.size === 0) return storedFrequencies()
      if (frequencies !== null && frequenciesRevision === tombstones.revision) return frequencies
      const live: Record<string, number> = Object.create(null)
      for (let at = 0; at < table.size; at++) {
        const documents = documentFrequency(at)
        if (documents > 0) live[table.tokenAt(at)] = documents
      }
      frequencies = live
      frequenciesRevision = tombstones.revision
      return frequencies
    },

    subtractRemoved(ordinal: number): void {
      lengths ??= { ...columns.totalFieldLengths }
      for (let field = 0; field < columns.fieldLengthNames.length; field++) {
        lengths[columns.fieldLengthNames[field]] -= columns.fieldLengthColumns[field][ordinal]
      }
      if (index !== null) {
        countRemoval(index, ordinal)
        return
      }
      const built = tryBuildRemovalIndex(columns, table)
      if (built === null) return
      for (const removed of tombstones.values()) countRemoval(built, removed)
      index = built
    },

    bytes(): number {
      if (index === null) return 0
      return (
        index.starts.byteLength +
        index.rows.byteLength +
        index.termOfSlot.byteLength +
        index.documents.byteLength +
        index.occurrences.byteLength
      )
    },
  }
}
