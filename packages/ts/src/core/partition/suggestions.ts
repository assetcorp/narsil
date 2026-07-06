import type { PartitionState } from './utils'

export interface PartitionSuggestion {
  token: string
  documentFrequency: number
  surfaces: Array<{ surface: string; occurrences: number }>
}

interface TokenGroup {
  documentFrequency: number
  surfaces: Array<{ surface: string; occurrences: number }>
}

// Total term frequency runs stale-high until compaction; counts only break
// ties between display spellings, so visibility stays correct.
function verbatimOccurrences(state: PartitionState, token: string): number {
  const postingList = state.invertedIdx.lookup(token)
  if (!postingList) return 0
  const derived = postingList.totalTermFrequency - state.surfaceRegistry.stemChangedTotalFor(token)
  return derived > 0 ? derived : 0
}

export function suggestDisplayTerms(
  state: PartitionState,
  surfacePrefix: string,
  stemmedPrefix: string,
  limit: number,
): PartitionSuggestion[] {
  if (limit <= 0 || surfacePrefix.length === 0) return []

  const groups = new Map<string, TokenGroup>()

  for (const candidate of state.surfaceRegistry.candidatesForPrefix(surfacePrefix)) {
    const postingList = state.invertedIdx.lookup(candidate.token)
    if (!postingList || postingList.docIdSet.size === 0) continue

    let group = groups.get(candidate.token)
    if (!group) {
      group = { documentFrequency: postingList.docIdSet.size, surfaces: [] }
      groups.set(candidate.token, group)
    }
    group.surfaces.push({ surface: candidate.surface, occurrences: candidate.occurrences })
  }

  const termPrefixes =
    state.surfaceRegistry.size() === 0 && stemmedPrefix !== surfacePrefix && stemmedPrefix.length > 0
      ? [surfacePrefix, stemmedPrefix]
      : [surfacePrefix]

  for (const prefix of termPrefixes) {
    for (const suggestion of state.invertedIdx.prefixSearch(prefix, Number.MAX_SAFE_INTEGER)) {
      const occurrences = verbatimOccurrences(state, suggestion.term)
      if (occurrences === 0) continue

      let group = groups.get(suggestion.term)
      if (!group) {
        group = { documentFrequency: suggestion.documentFrequency, surfaces: [] }
        groups.set(suggestion.term, group)
      } else if (group.surfaces.some(s => s.surface === suggestion.term)) {
        continue
      }
      group.surfaces.push({ surface: suggestion.term, occurrences })
    }
  }

  const results: PartitionSuggestion[] = []
  for (const [token, group] of groups) {
    results.push({ token, documentFrequency: group.documentFrequency, surfaces: group.surfaces })
  }
  results.sort((a, b) => b.documentFrequency - a.documentFrequency || (a.token < b.token ? -1 : 1))
  if (results.length > limit) results.length = limit
  return results
}

// Expansion runs in surface space because a typed prefix can be longer than
// the stem it maps to ("securi" never prefixes the term "secur").
export function expandTermPrefix(
  state: PartitionState,
  surfacePrefix: string,
  stemmedToken: string,
  maxExpansions: number,
): string[] {
  if (maxExpansions <= 0 || surfacePrefix.length === 0) return []

  const dfByToken = new Map<string, number>()

  for (const candidate of state.surfaceRegistry.candidatesForPrefix(surfacePrefix)) {
    if (dfByToken.has(candidate.token)) continue
    const postingList = state.invertedIdx.lookup(candidate.token)
    if (!postingList || postingList.docIdSet.size === 0) continue
    dfByToken.set(candidate.token, postingList.docIdSet.size)
  }

  const termPrefixes =
    state.surfaceRegistry.size() === 0 && stemmedToken !== surfacePrefix && stemmedToken.length > 0
      ? [surfacePrefix, stemmedToken]
      : [surfacePrefix]

  for (const prefix of termPrefixes) {
    for (const suggestion of state.invertedIdx.prefixSearch(prefix, Number.MAX_SAFE_INTEGER)) {
      if (dfByToken.has(suggestion.term)) continue
      if (verbatimOccurrences(state, suggestion.term) === 0) continue
      dfByToken.set(suggestion.term, suggestion.documentFrequency)
    }
  }

  const entries = Array.from(dfByToken.entries())
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (entries.length > maxExpansions) entries.length = maxExpansions
  return entries.map(e => e[0])
}
