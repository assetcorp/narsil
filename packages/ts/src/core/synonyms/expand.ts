import { SYNONYMS_ADDED_PER_QUERY } from './constants'
import type { QuerySynonyms, SynonymLookup } from './types'

export function expandQuerySynonyms(lookup: SynonymLookup, queryTokens: Iterable<string>): QuerySynonyms {
  const withSynonyms: Array<{ token: string; synonyms: readonly string[] }> = []
  const seen = new Set<string>()
  for (const token of queryTokens) {
    if (seen.has(token)) continue
    seen.add(token)
    const synonyms = lookup.synonymsOf(token)
    if (synonyms.length > 0) withSynonyms.push({ token, synonyms })
    if (withSynonyms.length === SYNONYMS_ADDED_PER_QUERY) break
  }
  const expanded = new Map<string, readonly string[]>()
  const count = withSynonyms.length
  if (count === 0) return expanded
  const share = Math.floor(SYNONYMS_ADDED_PER_QUERY / count)
  const extra = SYNONYMS_ADDED_PER_QUERY % count
  for (let i = 0; i < count; i++) {
    const quota = share + (i < extra ? 1 : 0)
    const { token, synonyms } = withSynonyms[i]
    expanded.set(token, synonyms.length <= quota ? synonyms : synonyms.slice(0, quota))
  }
  return expanded
}
