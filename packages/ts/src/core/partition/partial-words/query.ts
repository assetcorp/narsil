import {
  DEFAULT_FUZZY_PREFIX_LENGTH,
  PARTIAL_WORD_MIN_CODE_POINTS,
  PARTIAL_WORDS_ADDED_PER_QUERY,
} from '../../../search/constants'
import type { ExpandedTermGroup, ExpandedTermMember } from '../../../types/internal'
import { codePointCount } from '../../ordering/code-points'
import type { PartialWordAnalysis } from './spellings'
import type { AddedWord, PartialWordQuery, PartialWordQueryToken, PartialWordRequest } from './types'

function addPartialWords(group: ExpandedTermGroup, added: readonly AddedWord[]): void {
  const membersByToken = new Map<string, ExpandedTermMember>()
  for (const member of group.members) membersByToken.set(member.token, member)
  for (const word of added) {
    const member = membersByToken.get(word.token)
    if (member === undefined) {
      group.members.push({ token: word.token, factor: 0, partialFactor: word.factor })
    } else if (word.factor > member.partialFactor) {
      member.partialFactor = word.factor
    }
  }
}

function partialWordRequests(query: PartialWordQuery): Array<{ token: string; request: PartialWordRequest }> {
  const eligible: Array<{ token: string; written: string }> = []
  for (const queryToken of query.queryTokens) {
    const word = query.written.get(queryToken.position)
    if (word === undefined || codePointCount(word) < PARTIAL_WORD_MIN_CODE_POINTS) continue
    eligible.push({ token: queryToken.token, written: word })
    if (eligible.length === PARTIAL_WORDS_ADDED_PER_QUERY) break
  }
  const count = eligible.length
  if (count === 0) return []
  const evenShare = Math.floor(PARTIAL_WORDS_ADDED_PER_QUERY / count)
  const remainder = PARTIAL_WORDS_ADDED_PER_QUERY % count
  return eligible.map((entry, order) => ({
    token: entry.token,
    request: {
      written: entry.written,
      ownToken: entry.token,
      share: evenShare + (order < remainder ? 1 : 0),
      tolerance: entry.token === query.prefixToken ? 0 : query.tolerance,
      prefixLength: query.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
    },
  }))
}

export function addPartialWordMembers(
  query: PartialWordQuery,
  expand: (analysis: PartialWordAnalysis, requests: readonly PartialWordRequest[]) => AddedWord[][],
  groupOf: (token: string, typoMatches: boolean) => ExpandedTermGroup,
): void {
  const requests = partialWordRequests(query)
  const added = expand(
    query.analysis,
    requests.map(entry => entry.request),
  )
  for (let at = 0; at < requests.length; at++) {
    if (added[at].length === 0) continue
    const token = requests[at].token
    addPartialWords(groupOf(token, token !== query.prefixToken), added[at])
  }
}

export function partialWordsToHighlight(
  queryTokens: readonly PartialWordQueryToken[],
  writtenWords: readonly PartialWordQueryToken[],
): string[] {
  const writtenAt = new Map<number, string>()
  for (const word of writtenWords) {
    if (!writtenAt.has(word.position)) writtenAt.set(word.position, word.token)
  }
  const seenTokens = new Set<string>()
  const words: string[] = []
  for (const queryToken of queryTokens) {
    if (seenTokens.has(queryToken.token)) continue
    seenTokens.add(queryToken.token)
    const word = writtenAt.get(queryToken.position)
    if (word === undefined || codePointCount(word) < PARTIAL_WORD_MIN_CODE_POINTS) continue
    words.push(word)
    if (words.length === PARTIAL_WORDS_ADDED_PER_QUERY) break
  }
  return words
}
