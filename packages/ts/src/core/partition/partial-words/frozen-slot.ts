import type { FrozenTokenTable } from '../frozen/token-table'
import { FROZEN_PARTIAL_REMOVED_ENTRY_BYTES } from './constants'
import { buildPartialWordTable, partialWordTableBytes, readPartialWordTable } from './frozen-table'
import {
  countDocumentSpellings,
  encodePartialSpellings,
  type PartialWordAnalysis,
  type SpellingCounts,
  sameFields,
  spellingCountsOf,
} from './spellings'
import type {
  FrozenPartialWordDocuments,
  FrozenPartialWordSlot,
  PartialWordReader,
  PartialWordTableData,
  PartialWordTableReader,
} from './types'

export function createFrozenPartialWordSlot(
  initial: PartialWordTableData | null,
  tokenTable: FrozenTokenTable,
  documents: FrozenPartialWordDocuments,
): FrozenPartialWordSlot {
  let table = initial
  let removedCounts = new Map<number, number>()
  let reader: PartialWordTableReader | null =
    initial === null ? null : readPartialWordTable(initial, tokenTable, removedCounts)
  let pendingRemovals: number[] = []

  function subtractPendingRemovals(current: PartialWordTableReader, analysis: PartialWordAnalysis): void {
    if (pendingRemovals.length === 0) return
    const removed: SpellingCounts = new Map()
    for (const ordinal of pendingRemovals) countDocumentSpellings(removed, documents.documentAt(ordinal), analysis, 1)
    pendingRemovals = []
    for (const [token, bySpelling] of removed) {
      for (const [spelling, count] of bySpelling) {
        const entry = current.entryOf(spelling, token)
        if (entry >= 0) removedCounts.set(entry, (removedCounts.get(entry) ?? 0) + count)
      }
    }
  }

  return {
    readerFor(analysis: PartialWordAnalysis): PartialWordReader | null {
      if (analysis.fields.length === 0) return null
      if (table === null || reader === null || !sameFields(table.fields, analysis.fields)) {
        const counts = spellingCountsOf(documents.survivors(), analysis)
        table = buildPartialWordTable(encodePartialSpellings(analysis.fields, counts), tokenTable)
        removedCounts = new Map()
        pendingRemovals = []
        reader = readPartialWordTable(table, tokenTable, removedCounts)
        return reader
      }
      subtractPendingRemovals(reader, analysis)
      return reader
    },

    afterRemoval(ordinal: number): void {
      if (table !== null) pendingRemovals.push(ordinal)
    },

    spellings() {
      return null
    },

    bytes(): number {
      if (table === null) return 0
      return partialWordTableBytes(table) + removedCounts.size * FROZEN_PARTIAL_REMOVED_ENTRY_BYTES
    },
  }
}
