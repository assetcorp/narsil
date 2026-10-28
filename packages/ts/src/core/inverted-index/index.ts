import type {
  FieldNameTable,
  InternalIdResolver,
  PostingEntry,
  PostingList,
  PostingListView,
} from '../../types/internal'
import { MAX_TERM_FREQUENCY } from '../constants'
import { boundedLevenshtein, fuzzyPrefixOf } from '../fuzzy'
import { compareCodePoints } from '../ordering'
import { TERM_ENTRY_ESTIMATED_BYTES, TOKEN_STRING_HEADER_BYTES } from './constants'
import { LivePostings } from './postings'

export interface TermSuggestion {
  term: string
  documentFrequency: number
}

export interface InvertedIndexReader {
  lookup(token: string): PostingListView | undefined
  lookupReadOnce?(token: string): PostingListView | undefined
  documentFrequency(token: string): number
  fuzzyLookup(
    token: string,
    tolerance: number,
    prefixLength: number,
  ): Array<{ token: string; postingList: PostingListView }>
  prefixSearch(prefix: string, limit: number): TermSuggestion[]
  has(token: string): boolean
  tokens(): IterableIterator<string>
  size(): number
}

export interface InvertedIndex extends InvertedIndexReader {
  insert(
    token: string,
    internalId: number,
    termFrequency: number,
    fieldNameIndex: number,
    positions: readonly number[] | null,
  ): void
  remove(token: string, internalId: number, occurrences: number): void
  beginBatch(): void
  endBatch(): void
  clear(): void
  estimateBytes(): number
  serialize(resolver: InternalIdResolver): Record<string, PostingList>
  deserialize(data: Record<string, PostingList>, resolver: InternalIdResolver): void
}

function fieldIndexFor(fieldNameTable: FieldNameTable, fieldName: string): number {
  let index = fieldNameTable.indexMap.get(fieldName)
  if (index === undefined) {
    index = fieldNameTable.names.length
    fieldNameTable.names.push(fieldName)
    fieldNameTable.indexMap.set(fieldName, index)
  }
  return index
}

export function createInvertedIndex(fieldNameTable: FieldNameTable): InvertedIndex {
  const postings = new LivePostings()

  function* liveTokens(): IterableIterator<string> {
    const terms = postings.terms
    const generation = terms.generation
    for (let ordinal = 0; ordinal < terms.count && terms.generation === generation; ordinal++) {
      if (terms.isLive(ordinal)) yield terms.tokens[ordinal]
    }
  }

  function serializeTerm(ordinal: number, resolver: InternalIdResolver): PostingEntry[] {
    const list = postings.view(ordinal, false)
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, length } = list
    const positions = list.positions
    const entries: PostingEntry[] = []
    for (let i = 0; i < length; i++) {
      if (deletedDocs.size > 0 && deletedDocs.has(docIds[i])) continue
      const externalId = resolver.toExternal(docIds[i])
      if (externalId === undefined) continue
      entries.push({
        docId: externalId,
        termFrequency: termFrequencies[i],
        fieldName: fieldNameTable.names[fieldNameIndices[i]],
        positions: positions === null ? [] : [...positions[i]],
      })
    }
    return entries
  }

  return {
    insert(
      token: string,
      internalId: number,
      termFrequency: number,
      fieldNameIndex: number,
      positions: readonly number[] | null,
    ): void {
      postings.insert(token, internalId, termFrequency, fieldNameIndex, positions)
    },

    remove(token: string, internalId: number, occurrences: number): void {
      postings.remove(token, internalId, occurrences)
    },

    beginBatch(): void {
      postings.beginBatch()
    },

    endBatch(): void {
      postings.endBatch()
    },

    lookup(token: string): PostingListView | undefined {
      const ordinal = postings.terms.ids.get(token)
      return ordinal === undefined ? undefined : postings.view(ordinal, true)
    },

    lookupReadOnce(token: string): PostingListView | undefined {
      const ordinal = postings.terms.ids.get(token)
      return ordinal === undefined ? undefined : postings.view(ordinal, false)
    },

    documentFrequency(token: string): number {
      const ordinal = postings.terms.ids.get(token)
      return ordinal === undefined ? 0 : postings.terms.docFrequency[ordinal]
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: PostingListView }> {
      const terms = postings.terms
      if (tolerance === 0) {
        const exact = terms.ids.get(token)
        return exact === undefined ? [] : [{ token, postingList: postings.view(exact, true) }]
      }
      const results: Array<{ token: string; postingList: PostingListView }> = []
      terms.forEachStartingWith(fuzzyPrefixOf(token, prefixLength), ordinal => {
        const candidate = terms.tokens[ordinal]
        if (boundedLevenshtein(token, candidate, tolerance).withinTolerance) {
          results.push({ token: candidate, postingList: postings.view(ordinal, true) })
        }
      })
      return results
    },

    prefixSearch(prefix: string, limit: number): TermSuggestion[] {
      if (prefix.length === 0 || limit <= 0) return []
      const terms = postings.terms
      const results: TermSuggestion[] = []
      terms.forEachStartingWith(prefix, ordinal => {
        results.push({ term: terms.tokens[ordinal], documentFrequency: terms.docFrequency[ordinal] })
      })
      results.sort((a, b) => b.documentFrequency - a.documentFrequency || compareCodePoints(a.term, b.term))
      if (results.length > limit) results.length = limit
      return results
    },

    has(token: string): boolean {
      return postings.terms.ids.has(token)
    },

    tokens(): IterableIterator<string> {
      return liveTokens()
    },

    size(): number {
      return postings.terms.liveCount
    },

    clear(): void {
      postings.clear()
    },

    estimateBytes(): number {
      const terms = postings.terms
      const perTerm = TERM_ENTRY_ESTIMATED_BYTES + TOKEN_STRING_HEADER_BYTES
      return postings.byteLength() + terms.liveCount * perTerm + terms.tokenCodeUnits * 2
    },

    serialize(resolver: InternalIdResolver): Record<string, PostingList> {
      const result: Record<string, PostingList> = Object.create(null)
      const terms = postings.terms
      for (let ordinal = 0; ordinal < terms.count; ordinal++) {
        if (!terms.isLive(ordinal)) continue
        const entries = serializeTerm(ordinal, resolver)
        if (entries.length > 0) {
          result[terms.tokens[ordinal]] = { docFrequency: terms.docFrequency[ordinal], postings: entries }
        }
      }
      return result
    },

    deserialize(data: Record<string, PostingList>, resolver: InternalIdResolver): void {
      postings.clear()
      for (const token of Object.keys(data)) {
        const source = data[token].postings
        let hasPositions = false
        let valid = 0
        for (const posting of source) {
          if (resolver.toInternal(posting.docId) === undefined) continue
          valid++
          if (posting.positions.length > 0) hasPositions = true
        }
        if (valid === 0) continue
        postings.reserve(token, valid)
        for (const posting of source) {
          const internalId = resolver.toInternal(posting.docId)
          if (internalId === undefined) continue
          const termFrequency = posting.termFrequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : posting.termFrequency
          const fieldIndex = fieldIndexFor(fieldNameTable, posting.fieldName)
          postings.insert(token, internalId, termFrequency, fieldIndex, hasPositions ? posting.positions : null)
        }
      }
    },
  }
}
