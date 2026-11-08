import type { ExpandedTermGroup, InternalSearchParams, PostingListView } from '../../types/internal'
import { TERM_ORDERED } from '../inverted-index/terms'
import type { KeywordRequestBuilder } from '../keyword-score/request'
import { termGroupOf, typoMatchesFor } from './group-scoring'
import type { PhraseMatches } from './phrase-matching'
import type { PartitionReadState } from './read-state'

export interface PlannedLists {
  readonly labels: string[]
}

const planned: PlannedLists = { labels: [] }

const ABSENT_TERM = 0xffffffff

function frequencyOf(
  state: PartitionReadState,
  params: InternalSearchParams,
  token: string,
  list: PostingListView | undefined,
): number {
  const stats = params.globalStats
  if (stats !== undefined && Object.hasOwn(stats.docFrequencies, token)) return stats.docFrequencies[token]
  if (list !== undefined) return list.docIdSet.size
  return state.invertedIdx.documentFrequency(token)
}

function planTermRanges(
  state: PartitionReadState,
  params: InternalSearchParams,
  builder: KeywordRequestBuilder,
): boolean {
  const index = state.invertedIdx
  const postings = index.livePostings
  if (postings === undefined || index.lookupOrdinals === undefined) return false
  const { pool, terms } = postings
  if (!builder.readsPool(pool.docIds, pool.frequencies, pool.fieldIndices)) return false
  const { queryTokens } = params
  const stats = params.globalStats
  const ordinals = index.lookupOrdinals(queryTokens.map(queryToken => queryToken.token))
  for (let term = 0; term < queryTokens.length; term++) {
    builder.termSlot(term)
    const ordinal = ordinals[term]
    if (ordinal === ABSENT_TERM) continue
    const token = queryTokens[term].token
    const live = terms.isLive(ordinal)
    const documentFrequency =
      stats !== undefined && Object.hasOwn(stats.docFrequencies, token)
        ? stats.docFrequencies[token]
        : live
          ? terms.frequencyAt(ordinal)
          : 0
    builder.termRange(
      live ? terms.sliceStart[ordinal] : 0,
      live ? terms.lengths[ordinal] : 0,
      !live || (terms.flags[ordinal] & TERM_ORDERED) !== 0,
      documentFrequency,
    )
    planned.labels.push(token)
  }
  return true
}

function planGroup(
  state: PartitionReadState,
  params: InternalSearchParams,
  builder: KeywordRequestBuilder,
  group: ExpandedTermGroup,
  term: number,
): void {
  const lookup = (token: string): PostingListView | undefined => state.invertedIdx.lookup(token)
  const synonyms = group.synonyms
  let documentFrequency = synonyms?.documentFrequency(token => frequencyOf(state, params, token, undefined)) ?? 0
  const members: Array<{ token: string; factor: number; partialFactor: number; list: PostingListView }> = []
  for (const member of group.members) {
    documentFrequency = Math.max(documentFrequency, frequencyOf(state, params, member.token, undefined))
    const list =
      synonyms !== undefined && member.token === group.token
        ? synonyms.postings(lookup, member.token)
        : lookup(member.token)
    if (list !== undefined)
      members.push({ token: member.token, factor: member.factor, partialFactor: member.partialFactor, list })
  }
  builder.groupSlot(term, documentFrequency)
  for (const member of members) {
    builder.memberList(member.list, member.factor, member.partialFactor)
    planned.labels.push(member.token)
  }
}

function planPhrases(
  state: PartitionReadState,
  params: InternalSearchParams,
  builder: KeywordRequestBuilder,
  phraseMatches: PhraseMatches,
): void {
  for (const rows of phraseMatches.rows) {
    const frequencies = rows.phrase.tokens.map((token, at) => frequencyOf(state, params, token, rows.lists[at]))
    builder.phraseSlot(frequencies, {
      docIds: rows.docIds.values,
      fields: rows.fieldIndices.values,
      frequencies: rows.frequencies.values,
      count: rows.docIds.length,
    })
    planned.labels.push(rows.phrase.key)
  }
}

export function planKeywordSlots(
  state: PartitionReadState,
  params: InternalSearchParams,
  builder: KeywordRequestBuilder,
  phraseMatches: PhraseMatches | null,
): PlannedLists {
  planned.labels.length = 0
  const { queryTokens, termGroups } = params
  const exactTerms =
    queryTokens.length > 1 &&
    (termGroups === undefined || termGroups.length === 0) &&
    (params.exact === true || (params.tolerance ?? 0) === 0)
  if (exactTerms && planTermRanges(state, params, builder)) {
    if (phraseMatches !== null) planPhrases(state, params, builder, phraseMatches)
    return planned
  }
  const lists = exactTerms ? state.invertedIdx.lookupMany?.(queryTokens.map(queryToken => queryToken.token)) : undefined
  for (let term = 0; term < queryTokens.length; term++) {
    const token = queryTokens[term].token
    if (lists !== undefined) {
      builder.termSlot(term)
      const list = lists[term]
      if (list !== undefined) {
        builder.termList(list, frequencyOf(state, params, token, list))
        planned.labels.push(token)
      }
      continue
    }
    const group = termGroupOf(termGroups, token)
    const matches = typoMatchesFor(
      state.invertedIdx,
      token,
      group,
      params.exact ?? false,
      params.tolerance ?? 0,
      params.prefixLength ?? 2,
    )
    builder.termSlot(term)
    for (const match of matches) {
      builder.termList(match.postingList, frequencyOf(state, params, match.token, match.postingList))
      planned.labels.push(match.token)
    }
    if (group !== undefined) planGroup(state, params, builder, group, term)
  }
  if (phraseMatches !== null) planPhrases(state, params, builder, phraseMatches)
  return planned
}
