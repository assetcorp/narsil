import type { PostingListView } from '../../../types/internal'
import type { InvertedIndexReader, TermSuggestion } from '../../inverted-index'
import { TermLookup } from '../../term-table/lookup'
import type { FrozenLiveCounts } from './live-counts'
import type { FrozenPostingViews } from './posting-views'
import type { FrozenTokenTable } from './token-table'

export function createFrozenInvertedReader(
  table: FrozenTokenTable,
  views: FrozenPostingViews,
  counts: FrozenLiveCounts,
): InvertedIndexReader {
  const lookups = new TermLookup()
  function viewAtSorted(sortedIndex: number): PostingListView {
    return views.viewAt(table.payloadSlot(sortedIndex), sortedIndex)
  }

  function liveAt(token: string): number {
    const at = table.find(token)
    return at < 0 || counts.documentFrequency(at) === 0 ? -1 : at
  }

  return {
    lookup(token: string): PostingListView | undefined {
      const at = liveAt(token)
      if (at < 0) return undefined
      return viewAtSorted(at)
    },

    lookupMany(tokens: readonly string[]): Array<PostingListView | undefined> {
      const lists = new Array<PostingListView | undefined>(tokens.length)
      for (let term = 0; term < tokens.length; term++) {
        const at = liveAt(tokens[term])
        if (at >= 0) lists[term] = viewAtSorted(at)
      }
      return lists
    },

    lookupReadOnce(token: string): PostingListView | undefined {
      const at = liveAt(token)
      if (at < 0) return undefined
      return views.viewReadOnce(table.payloadSlot(at), at)
    },

    documentFrequency(token: string): number {
      const at = table.find(token)
      return at < 0 ? 0 : counts.documentFrequency(at)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: PostingListView }> {
      if (tolerance === 0) {
        const at = liveAt(token)
        return at < 0 ? [] : [{ token, postingList: viewAtSorted(at) }]
      }
      const results: Array<{ token: string; postingList: PostingListView }> = []
      for (const at of lookups.typo(counts.dictionary(), token, tolerance, prefixLength))
        results.push({ token: table.tokenAt(at), postingList: viewAtSorted(at) })

      return results
    },

    prefixSearch(prefix: string, limit: number): TermSuggestion[] {
      if (prefix.length === 0 || limit <= 0) return []

      const results: TermSuggestion[] = []
      for (const at of lookups.prefix(counts.dictionary(), prefix, limit)) {
        const documentFrequency = counts.documentFrequency(at)
        if (documentFrequency > 0) results.push({ term: table.tokenAt(at), documentFrequency })
      }

      return results
    },

    has(token: string): boolean {
      return liveAt(token) >= 0
    },

    *tokens(): IterableIterator<string> {
      for (let at = 0; at < table.size; at++) {
        yield table.tokenAt(at)
      }
    },

    size(): number {
      return table.size
    },
  }
}
