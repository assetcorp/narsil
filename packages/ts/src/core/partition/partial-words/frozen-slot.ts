import type { AnyDocument } from '../../../types/schema'
import { transformToken } from '../../tokenizer/cache'
import { resolveStopWords } from '../../tokenizer/tokenize'
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
  visitDocumentSpellings,
  visitDocumentSurfaceSpellings,
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

type UnstemmedSpelling = (spelling: string) => string | null

function countRemovedSpellings(
  removed: Map<string, number>,
  document: AnyDocument,
  analysis: PartialWordAnalysis,
): void {
  const count = (spelling: string): void => {
    removed.set(spelling, (removed.get(spelling) ?? 0) + 1)
  }
  if (analysis.options?.customTokenizer !== undefined) {
    visitDocumentSpellings(document, analysis, (_token, spelling) => count(spelling))
    return
  }
  visitDocumentSurfaceSpellings(document, analysis, count)
}

function unstemmedSpellingsOf(analysis: PartialWordAnalysis): UnstemmedSpelling {
  const { language } = analysis
  if (language.normalizer === undefined || language.tokenizer?.normalizeDiacritics === true) return () => null
  const stopWords = resolveStopWords(language, analysis.options?.stopWordOverride)
  return spelling => {
    if (stopWords.has(spelling)) return null
    const normalized = transformToken(spelling, language, false, false)
    return normalized === spelling ? null : normalized
  }
}

function subtractRemovedSpellings(
  counts: SpellingCounts,
  removed: ReadonlyMap<string, number>,
  analysis: PartialWordAnalysis,
): void {
  const tokenOf = new Map<string, string>()
  for (const [token, bySpelling] of counts) {
    for (const spelling of bySpelling.keys()) tokenOf.set(spelling, token)
  }
  const unstemmedSpelling = unstemmedSpellingsOf(analysis)
  for (const [spelling, count] of removed) {
    const stored = tokenOf.has(spelling) ? spelling : (unstemmedSpelling(spelling) ?? spelling)
    const token = tokenOf.get(stored)
    if (token !== undefined) countSpelling(counts, token, stored, -count)
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
    const removed = new Map<string, number>()
    for (const ordinal of pendingRemovals) countRemovedSpellings(removed, documents.documentAt(ordinal), analysis)
    pendingRemovals = []
    const unstemmedSpelling = unstemmedSpellingsOf(analysis)
    for (const [spelling, count] of removed) {
      let entry = current.entryOf(spelling)
      if (entry < 0) {
        const fallback = unstemmedSpelling(spelling)
        if (fallback !== null) entry = current.entryOf(fallback)
      }
      if (entry >= 0) removedCounts.set(entry, (removedCounts.get(entry) ?? 0) + count)
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
      const removed = new Map<string, number>()
      const returned: number[] = []
      for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
        const kept = mergedOrdinals[ordinal] >= 0
        if (kept === isCounted(ordinal)) continue
        if (kept) returned.push(ordinal)
        else countRemovedSpellings(removed, documents.documentAt(ordinal), analysis)
      }
      subtractRemovedSpellings(corrected, removed, analysis)
      for (const ordinal of returned) countDocumentSpellings(corrected, documents.documentAt(ordinal), analysis, 1)
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
