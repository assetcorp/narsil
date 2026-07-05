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

/**
 * Collects suggestion candidates whose surface form completes the typed
 * prefix, grouped by index token so each group represents one distinct
 * result set. Indexes serialised before surface forms existed have an empty
 * registry; those fall back to raw index terms so suggestions keep working,
 * at the cost of showing stemmed tokens.
 */
export function suggestDisplayTerms(
  state: PartitionState,
  surfacePrefix: string,
  stemmedPrefix: string,
  limit: number,
): PartitionSuggestion[] {
  if (limit <= 0 || surfacePrefix.length === 0) return []

  if (state.surfaceRegistry.size() === 0) {
    return legacyTermSuggestions(state, surfacePrefix, stemmedPrefix, limit)
  }

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

  const results: PartitionSuggestion[] = []
  for (const [token, group] of groups) {
    results.push({ token, documentFrequency: group.documentFrequency, surfaces: group.surfaces })
  }
  results.sort((a, b) => b.documentFrequency - a.documentFrequency || (a.token < b.token ? -1 : 1))
  if (results.length > limit) results.length = limit
  return results
}

function legacyTermSuggestions(
  state: PartitionState,
  surfacePrefix: string,
  stemmedPrefix: string,
  limit: number,
): PartitionSuggestion[] {
  const merged = new Map<string, number>()
  for (const suggestion of state.invertedIdx.prefixSearch(surfacePrefix, limit)) {
    merged.set(suggestion.term, suggestion.documentFrequency)
  }
  if (stemmedPrefix !== surfacePrefix && stemmedPrefix.length > 0) {
    for (const suggestion of state.invertedIdx.prefixSearch(stemmedPrefix, limit)) {
      merged.set(suggestion.term, suggestion.documentFrequency)
    }
  }

  const results: PartitionSuggestion[] = []
  for (const [token, documentFrequency] of merged) {
    results.push({ token, documentFrequency, surfaces: [{ surface: token, occurrences: 0 }] })
  }
  results.sort((a, b) => b.documentFrequency - a.documentFrequency || (a.token < b.token ? -1 : 1))
  if (results.length > limit) results.length = limit
  return results
}

/**
 * Expands a typed prefix into the index terms whose surface forms complete
 * it, most frequent first. The expansion runs in surface space because a
 * typed prefix can be longer than the stem it maps to ("securi" never
 * prefixes the term "secur"). Registry-less legacy indexes fall back to a
 * scan of the term dictionary.
 */
export function expandTermPrefix(
  state: PartitionState,
  surfacePrefix: string,
  stemmedToken: string,
  maxExpansions: number,
): string[] {
  if (maxExpansions <= 0 || surfacePrefix.length === 0) return []

  if (state.surfaceRegistry.size() === 0) {
    return legacyExpandTermPrefix(state, surfacePrefix, stemmedToken, maxExpansions)
  }

  const dfByToken = new Map<string, number>()
  for (const candidate of state.surfaceRegistry.candidatesForPrefix(surfacePrefix)) {
    if (dfByToken.has(candidate.token)) continue
    const postingList = state.invertedIdx.lookup(candidate.token)
    if (!postingList || postingList.docIdSet.size === 0) continue
    dfByToken.set(candidate.token, postingList.docIdSet.size)
  }

  return topTokensByFrequency(dfByToken, maxExpansions)
}

function legacyExpandTermPrefix(
  state: PartitionState,
  surfacePrefix: string,
  stemmedToken: string,
  maxExpansions: number,
): string[] {
  const dfByToken = new Map<string, number>()
  for (const suggestion of state.invertedIdx.prefixSearch(surfacePrefix, maxExpansions)) {
    dfByToken.set(suggestion.term, suggestion.documentFrequency)
  }
  if (stemmedToken !== surfacePrefix && stemmedToken.length > 0) {
    for (const suggestion of state.invertedIdx.prefixSearch(stemmedToken, maxExpansions)) {
      dfByToken.set(suggestion.term, suggestion.documentFrequency)
    }
  }
  return topTokensByFrequency(dfByToken, maxExpansions)
}

function topTokensByFrequency(dfByToken: Map<string, number>, maxExpansions: number): string[] {
  const entries = Array.from(dfByToken.entries())
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (entries.length > maxExpansions) entries.length = maxExpansions
  return entries.map(e => e[0])
}
