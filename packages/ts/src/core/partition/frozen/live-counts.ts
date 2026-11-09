import { readResidentMemory } from '#platform/process-limit'
import type { NativeExpansionSegment } from '../../../vector/native/types/expansion'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../../vector/native/types/frozen-segments'
import type { NativeTermDictionary } from '../../../vector/native/types/terms'
import { createFrozenRemovals, emptyPendingRegions } from '../../frozen-writes/publication'
import type { FrozenStringRemoval } from '../../frozen-writes/removal-strings'
import { TermLookup } from '../../term-table/lookup'
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
  | 'postingFieldIndices'
  | 'fieldNames'
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
  prepareRemoval(ordinal: number, strings?: FrozenStringRemoval): () => void
  pendingRemovals(): boolean
  settleRemovals(): void
  bytes(): number
  dictionary(): NativeTermDictionary
  expansionSource?(): NativeExpansionSegment
}

interface RemovalIndex {
  starts: Uint32Array
  rows: Uint32Array
  termOfSlot: Uint32Array
}

const UINT32_BYTES = 4

function removalIndexBytes(columns: CountedColumns, terms: number): number {
  const documentWords = 2 * (columns.documentCount + 1)
  return (columns.postingDocIds.length + documentWords + terms) * UINT32_BYTES
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
  const documents = new Uint32Array(table.size)
  const occurrences = new Float64Array(table.size)
  const dictionary = table.dictionary(documents)
  const lookups = new TermLookup()

  const empty = new Uint32Array(0)
  const segment: NativeFrozenSegment = {
    terms: { text: table.data.blob, offsets: table.data.offsets, counts: table.data.documentFrequencies },
    payloadSlots: table.data.payloadSlots,
    postingOffsets,
    postingDocuments: postingDocIds,
    postingFrequencies,
    postingFields: columns.postingFieldIndices,
    partialFields: new Uint8Array(columns.fieldNames.length),
    documentCount: columns.documentCount,
    surfaces: null,
    spellings: null,
    spellingTokens: empty,
    removalIndex: null,
  }
  const removalState: NativeFrozenSegmentState = {
    tombstones: tombstones.bits,
    tombstoneCount: tombstones.count,
    removedDocuments: documents,
    removedOccurrences: occurrences,
    removedSurfaces: empty,
    removedSpellings: empty,
    ...emptyPendingRegions(),
  }
  const removals = createFrozenRemovals(segment, removalState, null)

  function documentFrequency(sortedIndex: number): number {
    removals.settle()
    return lookups.frequency(dictionary, sortedIndex)
  }

  return {
    expansionSource: () => {
      removals.settle()
      return { growing: null, frozen: segment, state: removalState }
    },
    pendingRemovals: removals.pending,
    settleRemovals: removals.settle,
    dictionary(): NativeTermDictionary {
      removals.settle()
      return dictionary
    },
    totalDocuments(): number {
      return columns.documentCount - tombstones.size
    },

    totalFieldLengths(): Readonly<Record<string, number>> {
      return lengths ?? columns.totalFieldLengths
    },

    documentFrequency,

    removedOccurrences(sortedIndex: number): number {
      removals.settle()
      return occurrences[sortedIndex]
    },

    docFrequencies(): Readonly<Record<string, number>> {
      if (tombstones.size === 0) return storedFrequencies()
      removals.settle()
      if (frequencies !== null && frequenciesRevision === tombstones.revision) return frequencies
      const live: Record<string, number> = Object.create(null)
      for (let at = 0; at < table.size; at++) {
        const frequency = documentFrequency(at)
        if (frequency > 0) live[table.tokenAt(at)] = frequency
      }
      frequencies = live
      frequenciesRevision = tombstones.revision
      return frequencies
    },

    prepareRemoval(ordinal: number, strings?: FrozenStringRemoval): () => void {
      const nextLengths = lengths ?? { ...columns.totalFieldLengths }
      index ??= tryBuildRemovalIndex(columns, table)
      segment.removalIndex = index
      const publish = removals.prepare(ordinal, strings?.fields ?? [], strings)
      return () => {
        lengths ??= nextLengths
        for (let field = 0; field < columns.fieldLengthNames.length; field++) {
          lengths[columns.fieldLengthNames[field]] -= columns.fieldLengthColumns[field][ordinal]
        }
        publish()
      }
    },

    bytes(): number {
      const retained =
        documents.byteLength + occurrences.byteLength + segment.partialFields.byteLength + removals.bytes()
      return index === null
        ? retained
        : retained + index.starts.byteLength + index.rows.byteLength + index.termOfSlot.byteLength
    },
  }
}
