import type {
  CompactPostingList,
  FieldNameTable,
  InternalIdResolver,
  PostingEntry,
  PostingList,
} from '../types/internal'
import { boundedLevenshtein } from './fuzzy'

const INITIAL_CAPACITY = 8
const MAX_TERM_FREQUENCY = 65535
const COMPACTION_THRESHOLD = 0.3

export interface TermSuggestion {
  term: string
  documentFrequency: number
}

export interface InvertedIndex {
  insert(
    token: string,
    internalId: number,
    termFrequency: number,
    fieldNameIndex: number,
    positions: number[] | null,
  ): void
  remove(token: string, internalId: number): void
  lookup(token: string): CompactPostingList | undefined
  fuzzyLookup(
    token: string,
    tolerance: number,
    prefixLength: number,
  ): Array<{ token: string; postingList: CompactPostingList }>
  prefixSearch(prefix: string, limit: number): TermSuggestion[]
  has(token: string): boolean
  tokens(): IterableIterator<string>
  size(): number
  clear(): void
  serialize(resolver: InternalIdResolver): Record<string, PostingList>
  deserialize(data: Record<string, PostingList>, resolver: InternalIdResolver): void
}

export function createInvertedIndex(fieldNameTable: FieldNameTable): InvertedIndex {
  const index = new Map<string, CompactPostingList>()
  const charBuckets = new Map<string, Set<string>>()

  function trackToken(token: string): void {
    if (token.length === 0) return
    const ch = token[0]
    let bucket = charBuckets.get(ch)
    if (!bucket) {
      bucket = new Set()
      charBuckets.set(ch, bucket)
    }
    bucket.add(token)
  }

  function untrackToken(token: string): void {
    if (token.length === 0) return
    const ch = token[0]
    const bucket = charBuckets.get(ch)
    if (bucket) {
      bucket.delete(token)
      if (bucket.size === 0) charBuckets.delete(ch)
    }
  }

  function candidatesForPrefix(queryToken: string, prefixLength: number): Iterable<string> {
    if (prefixLength <= 0 || queryToken.length < prefixLength) {
      return index.keys()
    }
    const firstChar = queryToken[0]
    const bucket = charBuckets.get(firstChar)
    if (!bucket) return []
    if (prefixLength === 1) return bucket
    const prefix = queryToken.slice(0, prefixLength)
    const filtered: string[] = []
    for (const t of bucket) {
      if (t.length >= prefixLength && t.startsWith(prefix)) {
        filtered.push(t)
      }
    }
    return filtered
  }

  function getOrCreateList(token: string): CompactPostingList {
    let list = index.get(token)
    if (!list) {
      list = {
        length: 0,
        docIds: [],
        termFrequencies: new Uint16Array(INITIAL_CAPACITY),
        fieldNameIndices: new Uint8Array(INITIAL_CAPACITY),
        positions: null,
        docIdSet: new Set(),
        deletedDocs: new Set(),
      }
      index.set(token, list)
      trackToken(token)
    }
    return list
  }

  function growTypedArrays(list: CompactPostingList): void {
    const newCap = list.termFrequencies.length * 2

    const newTF = new Uint16Array(newCap)
    newTF.set(list.termFrequencies)
    list.termFrequencies = newTF

    const newFNI = new Uint8Array(newCap)
    newFNI.set(list.fieldNameIndices)
    list.fieldNameIndices = newFNI
  }

  function compactList(list: CompactPostingList): void {
    if (list.deletedDocs.size === 0) return

    let writeIdx = 0
    for (let i = 0; i < list.length; i++) {
      if (!list.deletedDocs.has(list.docIds[i])) {
        if (writeIdx !== i) {
          list.docIds[writeIdx] = list.docIds[i]
          list.termFrequencies[writeIdx] = list.termFrequencies[i]
          list.fieldNameIndices[writeIdx] = list.fieldNameIndices[i]
          if (list.positions) {
            list.positions[writeIdx] = list.positions[i]
          }
        }
        writeIdx++
      }
    }
    list.docIds.length = writeIdx
    if (list.positions) list.positions.length = writeIdx
    list.length = writeIdx
    list.deletedDocs.clear()
  }

  function compactDocEntries(list: CompactPostingList, internalId: number): void {
    let writeIdx = 0
    for (let i = 0; i < list.length; i++) {
      if (list.docIds[i] !== internalId) {
        if (writeIdx !== i) {
          list.docIds[writeIdx] = list.docIds[i]
          list.termFrequencies[writeIdx] = list.termFrequencies[i]
          list.fieldNameIndices[writeIdx] = list.fieldNameIndices[i]
          if (list.positions) {
            list.positions[writeIdx] = list.positions[i]
          }
        }
        writeIdx++
      }
    }
    list.docIds.length = writeIdx
    if (list.positions) list.positions.length = writeIdx
    list.length = writeIdx
  }

  return {
    insert(
      token: string,
      internalId: number,
      termFrequency: number,
      fieldNameIndex: number,
      positions: number[] | null,
    ): void {
      const list = getOrCreateList(token)

      if (list.deletedDocs.size > 0 && list.deletedDocs.has(internalId)) {
        compactDocEntries(list, internalId)
        list.deletedDocs.delete(internalId)
      }

      if (list.length >= list.termFrequencies.length) {
        growTypedArrays(list)
      }

      const idx = list.length
      list.docIds.push(internalId)
      list.termFrequencies[idx] = termFrequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : termFrequency
      list.fieldNameIndices[idx] = fieldNameIndex

      if (positions !== null) {
        if (!list.positions) {
          list.positions = []
          for (let j = 0; j < idx; j++) list.positions.push([])
        }
        list.positions.push(positions)
      } else if (list.positions !== null) {
        list.positions.push([])
      }

      if (!list.docIdSet.has(internalId)) {
        list.docIdSet.add(internalId)
      }

      list.length++
    },

    remove(token: string, internalId: number): void {
      const list = index.get(token)
      if (!list || !list.docIdSet.has(internalId)) return

      list.docIdSet.delete(internalId)
      list.deletedDocs.add(internalId)

      if (list.docIdSet.size === 0) {
        index.delete(token)
        untrackToken(token)
        return
      }

      if (list.deletedDocs.size / list.length > COMPACTION_THRESHOLD) {
        compactList(list)
      }
    },

    lookup(token: string): CompactPostingList | undefined {
      return index.get(token)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: CompactPostingList }> {
      if (tolerance === 0) {
        const exact = index.get(token)
        return exact ? [{ token, postingList: exact }] : []
      }

      const results: Array<{ token: string; postingList: CompactPostingList }> = []
      const candidates = candidatesForPrefix(token, prefixLength)

      for (const candidate of candidates) {
        const { withinTolerance } = boundedLevenshtein(token, candidate, tolerance)
        if (withinTolerance) {
          const postingList = index.get(candidate)
          if (postingList) results.push({ token: candidate, postingList })
        }
      }

      return results
    },

    prefixSearch(prefix: string, limit: number): TermSuggestion[] {
      if (prefix.length === 0 || limit <= 0) return []

      const candidates = candidatesForPrefix(prefix, prefix.length)
      const results: TermSuggestion[] = []

      for (const term of candidates) {
        if (!term.startsWith(prefix)) continue
        const list = index.get(term)
        if (!list) continue
        results.push({ term, documentFrequency: list.docIdSet.size })
      }

      results.sort((a, b) => b.documentFrequency - a.documentFrequency)
      if (results.length > limit) results.length = limit
      return results
    },

    has(token: string): boolean {
      return index.has(token)
    },

    tokens(): IterableIterator<string> {
      return index.keys()
    },

    size(): number {
      return index.size
    },

    clear(): void {
      index.clear()
      charBuckets.clear()
    },

    serialize(resolver: InternalIdResolver): Record<string, PostingList> {
      const result: Record<string, PostingList> = Object.create(null)
      for (const [token, list] of index) {
        const postings: PostingEntry[] = []
        for (let i = 0; i < list.length; i++) {
          if (list.deletedDocs.size > 0 && list.deletedDocs.has(list.docIds[i])) continue
          const externalId = resolver.toExternal(list.docIds[i])
          if (externalId === undefined) continue
          postings.push({
            docId: externalId,
            termFrequency: list.termFrequencies[i],
            fieldName: fieldNameTable.names[list.fieldNameIndices[i]],
            positions: list.positions ? list.positions[i] : [],
          })
        }
        if (postings.length > 0) {
          result[token] = { docFrequency: list.docIdSet.size, postings }
        }
      }
      return result
    },

    deserialize(data: Record<string, PostingList>, resolver: InternalIdResolver): void {
      index.clear()
      charBuckets.clear()
      for (const token of Object.keys(data)) {
        const src = data[token]
        const count = src.postings.length

        const docIdSet = new Set<number>()
        const docIds = new Array<number>(count)
        const termFrequencies = new Uint16Array(count)
        const fieldNameIndices = new Uint8Array(count)
        let hasPositions = false
        let validCount = 0

        for (let i = 0; i < count; i++) {
          const p = src.postings[i]
          const internalId = resolver.toInternal(p.docId)
          if (internalId === undefined) continue

          docIds[validCount] = internalId
          termFrequencies[validCount] = p.termFrequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : p.termFrequency

          let fnIndex = fieldNameTable.indexMap.get(p.fieldName)
          if (fnIndex === undefined) {
            fnIndex = fieldNameTable.names.length
            fieldNameTable.names.push(p.fieldName)
            fieldNameTable.indexMap.set(p.fieldName, fnIndex)
          }
          fieldNameIndices[validCount] = fnIndex

          docIdSet.add(internalId)
          if (p.positions.length > 0) hasPositions = true
          validCount++
        }

        if (validCount === 0) continue

        docIds.length = validCount
        const finalTF = validCount < count ? termFrequencies.slice(0, validCount) : termFrequencies
        const finalFNI = validCount < count ? fieldNameIndices.slice(0, validCount) : fieldNameIndices

        let positions: number[][] | null = null
        if (hasPositions) {
          positions = new Array(validCount)
          let vi = 0
          for (let i = 0; i < count; i++) {
            const internalId = resolver.toInternal(src.postings[i].docId)
            if (internalId === undefined) continue
            positions[vi] = src.postings[i].positions
            vi++
          }
        }

        index.set(token, {
          length: validCount,
          docIds,
          termFrequencies: finalTF,
          fieldNameIndices: finalFNI,
          positions,
          docIdSet,
          deletedDocs: new Set(),
        })
        trackToken(token)
      }
    },
  }
}
