import type { FoldedQueryTerm, PostingListView } from '../../types/internal'
import { addFoldedTypoMatches } from '../folding/code'
import type { InvertedIndexReader } from '../inverted-index'

type TypoMatch = { token: string; postingList: PostingListView }

export function foldedTermOf(
  terms: readonly FoldedQueryTerm[] | undefined,
  token: string,
): FoldedQueryTerm | undefined {
  if (terms === undefined) return undefined
  for (const term of terms) {
    if (term.token === token) return term
  }
  return undefined
}

export function withFoldedTypoMatches(
  index: Pick<InvertedIndexReader, 'lookup'>,
  matches: TypoMatch[],
  folded: FoldedQueryTerm | undefined,
): TypoMatch[] {
  return folded === undefined ? matches : addFoldedTypoMatches(index, matches, folded)
}

export function hasFoldedTerms(terms: readonly FoldedQueryTerm[] | undefined): boolean {
  return terms !== undefined && terms.length > 0
}
