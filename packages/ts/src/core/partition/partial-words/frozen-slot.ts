import type { FrozenTokenTable } from '../frozen/token-table'
import { FROZEN_PARTIAL_REMOVED_ENTRY_BYTES } from './constants'
import { buildPartialWordTable, countTableSpellings, partialWordTableBytes, readPartialWordTable } from './frozen-table'
import {
  countDocumentSpellings,
  countSpelling,
  encodePartialSpellings,
  type PartialWordAnalysis,
  type SpellingCounts,
  sameFields,
} from './spellings'
import type {
  FrozenPartialWordDocuments,
  FrozenPartialWordSlot,
  PartialWordReader,
  PartialWordTableData,
  PartialWordTableReader,
} from './types'

function tombstonedOrdinalsOf(documents: FrozenPartialWordDocuments): Uint8Array | null {
  let marks: Uint8Array | null = null
  for (let ordinal = 0; ordinal < documents.count; ordinal++) {
    if (!documents.isTombstoned(ordinal)) continue
    marks ??= new Uint8Array(documents.count)
    marks[ordinal] = 1
  }
  return marks
}

function addCounts(target: SpellingCounts, source: SpellingCounts): void {
  for (const [token, bySpelling] of source) {
    for (const [spelling, count] of bySpelling) countSpelling(target, token, spelling, count)
  }
}

export function createFrozenPartialWordSlot(
  initial: PartialWordTableData | null,
  tokenTable: FrozenTokenTable,
  documents: FrozenPartialWordDocuments,
): FrozenPartialWordSlot {
  let table = initial
  let uncounted: Uint8Array | null = null
  let removedCounts = new Map<number, number>()
  let reader: PartialWordTableReader | null =
    initial === null ? null : readPartialWordTable(initial, tokenTable, removedCounts)
  let pendingRemovals: number[] = []

  function isCounted(ordinal: number): boolean {
    return uncounted === null || uncounted[ordinal] === 0
  }

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

  function rebuild(analysis: PartialWordAnalysis): PartialWordTableReader {
    uncounted = tombstonedOrdinalsOf(documents)
    const counts: SpellingCounts = new Map()
    for (let ordinal = 0; ordinal < documents.count; ordinal++) {
      if (isCounted(ordinal)) countDocumentSpellings(counts, documents.documentAt(ordinal), analysis, 1)
    }
    const rebuilt = buildPartialWordTable(encodePartialSpellings(analysis.fields, counts), tokenTable)
    table = rebuilt
    removedCounts = new Map()
    pendingRemovals = []
    const rebuiltReader = readPartialWordTable(rebuilt, tokenTable, removedCounts)
    reader = rebuiltReader
    return rebuiltReader
  }

  function correctionsAgainstTable(mergedOrdinals: Int32Array): number {
    let corrections = 0
    for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
      if (mergedOrdinals[ordinal] >= 0 !== isCounted(ordinal)) corrections += 1
    }
    return corrections
  }

  function keptCount(mergedOrdinals: Int32Array): number {
    let kept = 0
    for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
      if (mergedOrdinals[ordinal] >= 0) kept += 1
    }
    return kept
  }

  return {
    readerFor(analysis: PartialWordAnalysis): PartialWordReader | null {
      if (analysis.fields.length === 0) return null
      if (table === null || reader === null || !sameFields(table.fields, analysis.fields)) return rebuild(analysis)
      subtractPendingRemovals(reader, analysis)
      return reader
    },

    afterRemoval(ordinal: number): void {
      if (table !== null) pendingRemovals.push(ordinal)
    },

    tableOfEveryDocument(analysis: PartialWordAnalysis): PartialWordTableData | null {
      if (table === null || uncounted !== null || !sameFields(table.fields, analysis.fields)) return null
      return table
    },

    countKeptSpellings(counts: SpellingCounts, analysis: PartialWordAnalysis, mergedOrdinals: Int32Array): void {
      if (
        table === null ||
        !sameFields(table.fields, analysis.fields) ||
        correctionsAgainstTable(mergedOrdinals) > keptCount(mergedOrdinals)
      ) {
        for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
          if (mergedOrdinals[ordinal] >= 0) countDocumentSpellings(counts, documents.documentAt(ordinal), analysis, 1)
        }
        return
      }
      const corrected: SpellingCounts = new Map()
      countTableSpellings(corrected, table, tokenTable)
      for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
        const kept = mergedOrdinals[ordinal] >= 0
        if (kept === isCounted(ordinal)) continue
        countDocumentSpellings(corrected, documents.documentAt(ordinal), analysis, kept ? 1 : -1)
      }
      addCounts(counts, corrected)
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
