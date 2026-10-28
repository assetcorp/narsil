import type { PostingListView } from '../../types/internal'
import { combinePostingLists } from './combined-postings'
import { SYNONYMS_ADDED_PER_QUERY } from './constants'
import type { GroupSynonyms, QuerySynonyms, SynonymLookup } from './types'

function groupSynonymsOf(tokens: readonly string[]): GroupSynonyms {
  return {
    tokens,
    has: token => tokens.includes(token),
    documentFrequency(frequencyOf) {
      let most = 0
      for (const token of tokens) most = Math.max(most, frequencyOf(token))
      return most
    },
    postings(lookup, own) {
      const lists: PostingListView[] = []
      for (const token of [own, ...tokens]) {
        const list = lookup(token)
        if (list !== undefined) lists.push(list)
      }
      return lists.length === 0 ? undefined : combinePostingLists(lists)
    },
  }
}

export function expandQuerySynonyms(lookup: SynonymLookup, queryTokens: Iterable<string>): QuerySynonyms | undefined {
  const withSynonyms: Array<{ token: string; synonyms: readonly string[] }> = []
  const seen = new Set<string>()
  for (const token of queryTokens) {
    if (seen.has(token)) continue
    seen.add(token)
    const synonyms = lookup.synonymsOf(token)
    if (synonyms.length > 0) withSynonyms.push({ token, synonyms })
    if (withSynonyms.length === SYNONYMS_ADDED_PER_QUERY) break
  }
  const count = withSynonyms.length
  if (count === 0) return undefined
  const share = Math.floor(SYNONYMS_ADDED_PER_QUERY / count)
  const extra = SYNONYMS_ADDED_PER_QUERY % count
  const expanded = new Map<string, readonly string[]>()
  const added = new Set<string>()
  for (let i = 0; i < count; i++) {
    const quota = share + (i < extra ? 1 : 0)
    const { token, synonyms } = withSynonyms[i]
    const kept = synonyms.length <= quota ? synonyms : synonyms.slice(0, quota)
    expanded.set(token, kept)
    for (const synonym of kept) added.add(synonym)
  }
  return {
    tokens: [...added],
    addTo(groupOf) {
      for (const [token, synonyms] of expanded) {
        const group = groupOf(token)
        group.synonyms = groupSynonymsOf(synonyms)
        group.members = group.members.filter(member => member.token === token || !synonyms.includes(member.token))
      }
    },
  }
}
