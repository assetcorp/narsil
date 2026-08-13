import type { PostingListView } from '../../../types/internal'
import { boundedLevenshtein } from '../../fuzzy'
import type { InvertedIndexReader, TermSuggestion } from '../../inverted-index'
import { compareCodePoints } from '../../ordering'
import type { FrozenPostingViews } from './posting-views'
import type { FrozenTokenTable } from './token-table'

export function createFrozenInvertedReader(table: FrozenTokenTable, views: FrozenPostingViews): InvertedIndexReader {
  function viewAtSorted(sortedIndex: number): PostingListView {
    return views.viewAt(table.payloadSlot(sortedIndex), table.documentFrequencyAt(sortedIndex))
  }

  function candidateRange(queryToken: string, prefixLength: number): { start: number; end: number } {
    if (prefixLength <= 0 || queryToken.length < prefixLength) {
      return { start: 0, end: table.size }
    }
    return table.firstCharRange(queryToken)
  }

  return {
    lookup(token: string): PostingListView | undefined {
      const at = table.find(token)
      if (at < 0) return undefined
      return viewAtSorted(at)
    },

    fuzzyLookup(
      token: string,
      tolerance: number,
      prefixLength: number,
    ): Array<{ token: string; postingList: PostingListView }> {
      if (tolerance === 0) {
        const at = table.find(token)
        return at < 0 ? [] : [{ token, postingList: viewAtSorted(at) }]
      }

      const range = candidateRange(token, prefixLength)
      const needsPrefixFilter = prefixLength > 1 && token.length >= prefixLength
      const prefix = needsPrefixFilter ? token.slice(0, prefixLength) : ''
      const results: Array<{ token: string; postingList: PostingListView }> = []

      for (let at = range.start; at < range.end; at++) {
        const candidate = table.tokenAt(at)
        if (needsPrefixFilter && !(candidate.length >= prefixLength && candidate.startsWith(prefix))) continue
        const { withinTolerance } = boundedLevenshtein(token, candidate, tolerance)
        if (withinTolerance) {
          results.push({ token: candidate, postingList: viewAtSorted(at) })
        }
      }

      return results
    },

    prefixSearch(prefix: string, limit: number): TermSuggestion[] {
      if (prefix.length === 0 || limit <= 0) return []

      const range = table.prefixRange(prefix)
      const results: TermSuggestion[] = []
      for (let at = range.start; at < range.end; at++) {
        results.push({ term: table.tokenAt(at), documentFrequency: table.documentFrequencyAt(at) })
      }

      results.sort((a, b) => b.documentFrequency - a.documentFrequency || compareCodePoints(a.term, b.term))
      if (results.length > limit) results.length = limit
      return results
    },

    has(token: string): boolean {
      return table.find(token) >= 0
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
