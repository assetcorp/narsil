import { LivePostings } from '#platform/live-postings'
import type {
  FieldNameTable,
  InternalIdResolver,
  PostingEntry,
  PostingList,
  PostingListView,
} from '../../types/internal'
import { MAX_TERM_FREQUENCY } from '../constants'
import { TermLookup } from '../term-table/lookup'
import { TERM_ENTRY_ESTIMATED_BYTES, TOKEN_STRING_HEADER_BYTES } from './constants'
import { TERM_LIVE } from './terms'

export interface TermSuggestion {
  term: string
  documentFrequency: number
}

export interface InvertedIndexReader {
  lookup(token: string): PostingListView | undefined
  lookupMany?(tokens: readonly string[]): Array<PostingListView | undefined>
  lookupOrdinals?(tokens: readonly string[]): Uint32Array
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
  readonly livePostings?: Pick<LivePostings, 'pool' | 'retired' | 'terms' | 'positions'>
}

export interface InvertedIndex extends InvertedIndexReader {
  readonly livePostings: LivePostings
  addDocumentFrequencies(into: Record<string, number>): number
  insert(
    token: string,
    internalId: number,
    termFrequency: number,
    fieldNameIndex: number,
    positions: readonly number[] | null,
  ): void
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
  const lookups = new TermLookup()

  function* liveTokens(): IterableIterator<string> {
    const terms = postings.terms
    const generation = terms.generation
    for (let ordinal = 0; ordinal < terms.count && terms.generation === generation; ordinal++) {
      if (terms.isLive(ordinal) && terms.frequencyAt(ordinal) > 0) yield terms.tokens[ordinal]
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
    livePostings: postings,

    insert(
      token: string,
      internalId: number,
      termFrequency: number,
      fieldNameIndex: number,
      positions: readonly number[] | null,
    ): void {
      postings.insert(token, internalId, termFrequency, fieldNameIndex, positions)
    },

    endBatch(): void {
      postings.endBatch()
    },

    lookup(token: string): PostingListView | undefined {
      const ordinal = lookups.find(postings.terms.dictionary(), token)
      return ordinal === undefined ? undefined : postings.view(ordinal, true)
    },

    lookupMany(tokens: readonly string[]): Array<PostingListView | undefined> {
      const ordinals = lookups.findMany(postings.terms.dictionary(), tokens)
      const lists = new Array<PostingListView | undefined>(ordinals.length)
      for (let at = 0; at < ordinals.length; at++)
        if (ordinals[at] !== 0xffffffff) lists[at] = postings.view(ordinals[at], true)
      return lists
    },

    lookupOrdinals(tokens: readonly string[]): Uint32Array {
      return lookups.findMany(postings.terms.dictionary(), tokens)
    },

    lookupReadOnce(token: string): PostingListView | undefined {
      const ordinal = lookups.find(postings.terms.dictionary(), token)
      return ordinal === undefined ? undefined : postings.view(ordinal, false)
    },

    documentFrequency(token: string): number {
      const dictionary = postings.terms.dictionary()
      const ordinal = lookups.find(dictionary, token)
      return ordinal === undefined ? 0 : lookups.frequency(dictionary, ordinal)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: PostingListView }> {
      const terms = postings.terms
      const results: Array<{ token: string; postingList: PostingListView }> = []
      for (const ordinal of lookups.typo(terms.dictionary(), token, tolerance, prefixLength))
        results.push({ token: terms.tokens[ordinal], postingList: postings.view(ordinal, true) })
      return results
    },

    prefixSearch(prefix: string, limit: number): TermSuggestion[] {
      if (prefix.length === 0 || limit <= 0) return []
      const terms = postings.terms
      const dictionary = terms.dictionary()
      const results: TermSuggestion[] = []
      for (const ordinal of lookups.prefix(dictionary, prefix, limit))
        results.push({ term: terms.tokens[ordinal], documentFrequency: lookups.frequency(dictionary, ordinal) })
      return results
    },

    has(token: string): boolean {
      return lookups.find(postings.terms.dictionary(), token) !== undefined
    },

    tokens(): IterableIterator<string> {
      return liveTokens()
    },

    addDocumentFrequencies(into: Record<string, number>): number {
      const { count, flags, docFrequency, deadDocuments, tokens } = postings.terms
      let added = 0
      for (let ordinal = 0; ordinal < count; ordinal++) {
        if ((flags[ordinal] & TERM_LIVE) === 0) continue
        const documents = docFrequency[ordinal] - deadDocuments[ordinal]
        if (documents <= 0) continue
        const token = tokens[ordinal]
        const held = into[token]
        if (held === undefined) {
          into[token] = documents
          added++
        } else into[token] = held + documents
      }
      return added
    },

    size(): number {
      return postings.terms.nonemptyTerms()
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
          result[terms.tokens[ordinal]] = { docFrequency: terms.frequencyAt(ordinal), postings: entries }
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
