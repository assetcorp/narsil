import type { FoldedQueryTerm, PostingListView } from '../../types/internal'
import type { InvertedIndexReader } from '../inverted-index'
import { compareCodePoints } from '../ordering/code-points'

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
  if (folded === undefined) return matches
  const kept =
    folded.variants.length === 0
      ? matches
      : matches.filter(match => match.token === folded.token || !folded.variants.includes(match.token))
  if (folded.typoMatches.length === 0) return kept
  const held = new Set(kept.map(match => match.token))
  const added = kept === matches ? [...matches] : kept
  for (const token of folded.typoMatches) {
    if (held.has(token)) continue
    const postingList = index.lookup(token)
    if (postingList !== undefined) added.push({ token, postingList })
  }
  return added.length > 1 ? added.sort((left, right) => compareCodePoints(left.token, right.token)) : added
}

export function hasFoldedTerms(terms: readonly FoldedQueryTerm[] | undefined): boolean {
  return terms !== undefined && terms.length > 0
}
