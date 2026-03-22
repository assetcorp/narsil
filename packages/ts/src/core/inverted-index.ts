import type { CompactPostingList, FieldNameTable, PostingEntry, PostingList } from '../types/internal'
import { boundedLevenshtein } from './fuzzy'

const INITIAL_CAPACITY = 8
const MAX_TERM_FREQUENCY = 65535
const COMPACTION_THRESHOLD = 0.3

export interface InvertedIndex {
  insert(token: string, docId: string, termFrequency: number, fieldNameIndex: number, positions: number[] | null): void
  remove(token: string, docId: string): void
  lookup(token: string): CompactPostingList | undefined
  fuzzyLookup(
    token: string,
    tolerance: number,
    prefixLength: number,
  ): Array<{ token: string; postingList: CompactPostingList }>
  has(token: string): boolean
  tokens(): IterableIterator<string>
  size(): number
  clear(): void
  serialize(): Record<string, PostingList>
  deserialize(data: Record<string, PostingList>): void
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

  function compactDocEntries(list: CompactPostingList, docId: string): void {
    let writeIdx = 0
    for (let i = 0; i < list.length; i++) {
      if (list.docIds[i] !== docId) {
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
      docId: string,
      termFrequency: number,
      fieldNameIndex: number,
      positions: number[] | null,
    ): void {
      const list = getOrCreateList(token)

      if (list.deletedDocs.size > 0 && list.deletedDocs.has(docId)) {
        compactDocEntries(list, docId)
        list.deletedDocs.delete(docId)
      }

      if (list.length >= list.termFrequencies.length) {
        growTypedArrays(list)
      }

      const idx = list.length
      list.docIds.push(docId)
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

      if (!list.docIdSet.has(docId)) {
        list.docIdSet.add(docId)
      }

      list.length++
    },

    remove(token: string, docId: string): void {
      const list = index.get(token)
      if (!list || !list.docIdSet.has(docId)) return

      list.docIdSet.delete(docId)
      list.deletedDocs.add(docId)

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

    serialize(): Record<string, PostingList> {
      const result: Record<string, PostingList> = Object.create(null)
      for (const [token, list] of index) {
        const postings: PostingEntry[] = []
        for (let i = 0; i < list.length; i++) {
          if (list.deletedDocs.size > 0 && list.deletedDocs.has(list.docIds[i])) continue
          postings.push({
            docId: list.docIds[i],
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

    deserialize(data: Record<string, PostingList>): void {
      index.clear()
      charBuckets.clear()
      for (const token of Object.keys(data)) {
        const src = data[token]
        const count = src.postings.length

        const docIdSet = new Set<string>()
        const docIds = new Array<string>(count)
        const termFrequencies = new Uint16Array(count)
        const fieldNameIndices = new Uint8Array(count)
        let hasPositions = false

        for (let i = 0; i < count; i++) {
          const p = src.postings[i]
          docIds[i] = p.docId
          termFrequencies[i] = p.termFrequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : p.termFrequency

          let fnIndex = fieldNameTable.indexMap.get(p.fieldName)
          if (fnIndex === undefined) {
            fnIndex = fieldNameTable.names.length
            fieldNameTable.names.push(p.fieldName)
            fieldNameTable.indexMap.set(p.fieldName, fnIndex)
          }
          fieldNameIndices[i] = fnIndex

          docIdSet.add(p.docId)
          if (p.positions.length > 0) hasPositions = true
        }

        let positions: number[][] | null = null
        if (hasPositions) {
          positions = new Array(count)
          for (let i = 0; i < count; i++) {
            positions[i] = src.postings[i].positions
          }
        }

        index.set(token, {
          length: count,
          docIds,
          termFrequencies,
          fieldNameIndices,
          positions,
          docIdSet,
          deletedDocs: new Set(),
        })
        trackToken(token)
      }
    },
  }
}
