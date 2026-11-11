import type { PostingListView } from '../../types/internal'
import { combinePostingLists } from './combined-postings'
import type { GroupSynonyms, QuerySynonyms } from './types'

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

export function expandQuerySynonyms(expanded: ReadonlyMap<string, readonly string[]>): QuerySynonyms | undefined {
  if (expanded.size === 0) return undefined
  const added = new Set<string>()
  for (const synonyms of expanded.values()) for (const synonym of synonyms) added.add(synonym)
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
