import type { PostingEntry, PostingList } from '../types/internal'
import { boundedLevenshtein } from './fuzzy'

export type ReadonlyPostingList = {
  readonly docFrequency: number
  readonly postings: readonly Readonly<PostingEntry>[]
}

interface InternalPostingList extends PostingList {
  docIdToIndex: Map<string, number>
}

export interface InvertedIndex {
  insert(token: string, entry: PostingEntry): void
  remove(token: string, docId: string): void
  lookup(token: string): ReadonlyPostingList | undefined
  fuzzyLookup(
    token: string,
    tolerance: number,
    prefixLength: number,
  ): Array<{ token: string; postingList: ReadonlyPostingList }>
  has(token: string): boolean
  tokens(): IterableIterator<string>
  size(): number
  clear(): void
  serialize(): Record<string, PostingList>
  deserialize(data: Record<string, PostingList>): void
}

export function createInvertedIndex(): InvertedIndex {
  const index = new Map<string, InternalPostingList>()
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

  function getOrCreateList(token: string): InternalPostingList {
    let list = index.get(token)
    if (!list) {
      list = { docFrequency: 0, postings: [], docIdToIndex: new Map() }
      index.set(token, list)
      trackToken(token)
    }
    return list
  }

  return {
    insert(token: string, entry: PostingEntry): void {
      const list = getOrCreateList(token)
      const idx = list.postings.length
      list.postings.push(entry)
      if (!list.docIdToIndex.has(entry.docId)) {
        list.docIdToIndex.set(entry.docId, idx)
        list.docFrequency++
      }
    },

    remove(token: string, docId: string): void {
      const list = index.get(token)
      if (!list) return
      if (!list.docIdToIndex.has(docId)) return

      list.docIdToIndex.delete(docId)

      let writeIdx = 0
      for (let i = 0; i < list.postings.length; i++) {
        if (list.postings[i].docId !== docId) {
          if (writeIdx !== i) {
            list.postings[writeIdx] = list.postings[i]
            list.docIdToIndex.set(list.postings[i].docId, writeIdx)
          }
          writeIdx++
        }
      }
      list.postings.length = writeIdx
      list.docFrequency = list.docIdToIndex.size

      if (list.postings.length === 0) {
        index.delete(token)
        untrackToken(token)
      }
    },

    lookup(token: string): ReadonlyPostingList | undefined {
      return index.get(token)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: ReadonlyPostingList }> {
      if (tolerance === 0) {
        const exact = index.get(token)
        return exact ? [{ token, postingList: exact }] : []
      }

      const results: Array<{ token: string; postingList: ReadonlyPostingList }> = []
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
        result[token] = { docFrequency: list.docFrequency, postings: list.postings }
      }
      return result
    },

    deserialize(data: Record<string, PostingList>): void {
      index.clear()
      charBuckets.clear()
      for (const token of Object.keys(data)) {
        const src = data[token]
        const docIdToIndex = new Map<string, number>()
        for (let i = 0; i < src.postings.length; i++) {
          docIdToIndex.set(src.postings[i].docId, i)
        }
        index.set(token, {
          docFrequency: src.docFrequency,
          postings: src.postings,
          docIdToIndex,
        })
        trackToken(token)
      }
    },
  }
}
