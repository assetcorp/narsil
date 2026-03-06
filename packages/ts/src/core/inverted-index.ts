import type { PostingEntry, PostingList } from '../types/internal'
import { boundedLevenshtein } from './fuzzy'

export type ReadonlyPostingList = {
  readonly docFrequency: number
  readonly postings: readonly Readonly<PostingEntry>[]
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
  const index = new Map<string, PostingList>()
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

  return {
    insert(token: string, entry: PostingEntry): void {
      let list = index.get(token)
      if (!list) {
        list = { docFrequency: 0, postings: [] }
        index.set(token, list)
        trackToken(token)
      }

      const dupeIdx = list.postings.findIndex(p => p.docId === entry.docId && p.fieldName === entry.fieldName)

      if (dupeIdx !== -1) {
        list.postings[dupeIdx] = entry
        return
      }

      const isNewDoc = !list.postings.some(p => p.docId === entry.docId)
      list.postings.push(entry)
      if (isNewDoc) list.docFrequency++
    },

    remove(token: string, docId: string): void {
      const list = index.get(token)
      if (!list) return

      const lengthBefore = list.postings.length
      list.postings = list.postings.filter(p => p.docId !== docId)
      const removed = lengthBefore - list.postings.length

      if (removed > 0) list.docFrequency--

      if (list.postings.length === 0) {
        index.delete(token)
        untrackToken(token)
      }
    },

    lookup(token: string): PostingList | undefined {
      return index.get(token)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: PostingList }> {
      if (tolerance === 0) {
        const exact = index.get(token)
        return exact ? [{ token, postingList: exact }] : []
      }

      const results: Array<{ token: string; postingList: PostingList }> = []
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
        result[token] = list
      }
      return result
    },

    deserialize(data: Record<string, PostingList>): void {
      index.clear()
      charBuckets.clear()
      for (const token of Object.keys(data)) {
        index.set(token, data[token])
        trackToken(token)
      }
    },
  }
}
