import {
  codePointCount,
  combinePostingLists,
  compareCodePoints,
  partitionDocumentFrequency,
} from '../../engine/optional-reads-host-bindings'
import type { AnalysedPhrase, ExpandedTermGroup, FoldedQueryTerm, PostingListView } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { PrefixCompletion } from '../expansion/host'
import type { PartitionIndex } from '../partition/partition-index'
import type { PartitionReadState } from '../partition/read-state'
import { MAX_FOLDED_VARIANTS } from './constants'
import { type FoldingRules, foldedSpelling, foldingRulesOf, foldText } from './keys'
import { foldIndexOf, type SegmentFoldIndex, type SpellingRef, spellingIsHeld } from './segment-index'

type QueryToken = { token: string; position: number }

export interface FoldedTermRequest {
  partition: PartitionIndex
  language: LanguageModule
  queryTokens: readonly QueryToken[]
  written: ReadonlyMap<number, string>
  tolerance: number
  prefixLength: number
  termGroups: ExpandedTermGroup[] | undefined
}

export interface FoldedCompletionRequest {
  partition: PartitionIndex
  language: LanguageModule
  typed: string
  own: string
  completions: readonly PrefixCompletion[]
  limit: number
}

interface Ranked {
  token: string
  documents: number
}

function byDocumentsThenCodePoints(left: Ranked, right: Ranked): number {
  return right.documents - left.documents || compareCodePoints(left.token, right.token)
}

function heldTokens(
  states: readonly PartitionReadState[],
  rules: FoldingRules,
  collect: (index: SegmentFoldIndex, visit: (ref: SpellingRef) => void) => void,
): Set<string> {
  const tokens = new Set<string>()
  for (const state of states) {
    collect(foldIndexOf(state, rules), ref => {
      if (!tokens.has(ref.token) && spellingIsHeld(state, ref)) tokens.add(ref.token)
    })
  }
  return tokens
}

function rankedTokens(states: readonly PartitionReadState[], tokens: Iterable<string>, limit: number): Ranked[] {
  const ranked: Ranked[] = []
  for (const token of tokens) {
    const documents = partitionDocumentFrequency(states, token)
    if (documents > 0) ranked.push({ token, documents })
  }
  ranked.sort(byDocumentsThenCodePoints)
  if (ranked.length > limit) ranked.length = limit
  return ranked
}

export function mergeFoldedCompletions(request: FoldedCompletionRequest): PrefixCompletion[] {
  const { partition, typed, own, completions, limit } = request
  const rules = foldingRulesOf(request.language)
  const folded = foldText(typed, rules)
  const states = partition.readStates()
  const candidates = heldTokens(states, rules, (index, visit) => index.refsWithFoldPrefix(folded, visit))
  if (folded !== typed) {
    for (const completion of partition.expandTermPrefix(folded, own, limit)) candidates.add(completion.token)
  }
  for (const completion of completions) candidates.delete(completion.token)
  if (candidates.size === 0) return [...completions]
  for (const completion of completions) candidates.add(completion.token)
  const ownLength = codePointCount(own)
  return rankedTokens(states, candidates, limit).map(entry => ({
    token: entry.token,
    factor: Math.min(1, ownLength / codePointCount(entry.token)),
  }))
}

function foldedGroupOf(token: string, variants: readonly string[]): ExpandedTermGroup {
  return {
    token,
    members: [{ token, factor: 1, partialFactor: 1 }],
    typoMatches: false,
    synonyms: {
      tokens: variants,
      has: candidate => variants.includes(candidate),
      documentFrequency(frequencyOf) {
        let most = 0
        for (const variant of variants) most = Math.max(most, frequencyOf(variant))
        return most
      },
      postings(lookup, own) {
        const lists: PostingListView[] = []
        for (const candidate of [own, ...variants]) {
          const list = lookup(candidate)
          if (list !== undefined) lists.push(list)
        }
        return lists.length === 0 ? undefined : combinePostingLists(lists)
      },
    },
  }
}

function variantsOf(
  states: readonly PartitionReadState[],
  rules: FoldingRules,
  key: string,
  excluded: (token: string) => boolean,
): string[] {
  const found = heldTokens(states, rules, (index, visit) => index.refsWithKey(key, visit))
  found.add(key)
  const kept = rankedTokens(
    states,
    [...found].filter(token => !excluded(token)),
    MAX_FOLDED_VARIANTS,
  )
  return kept.map(entry => entry.token).sort(compareCodePoints)
}

function resolveTerm(
  request: FoldedTermRequest,
  rules: FoldingRules,
  group: ExpandedTermGroup | undefined,
  queryToken: QueryToken,
): FoldedQueryTerm | null {
  const { partition, tolerance, prefixLength } = request
  const states = partition.readStates()
  const own = queryToken.token
  const key = foldedSpelling(request.written.get(queryToken.position) ?? own, rules).key
  const excluded = (token: string): boolean => token === own || group?.synonyms?.has(token) === true
  const variants = variantsOf(states, rules, key, excluded)

  const typoMatches: string[] = []
  if (tolerance > 0 && (group === undefined || group.typoMatches)) {
    const near = heldTokens(states, rules, (index, visit) => index.refsNearKey(key, tolerance, prefixLength, visit))
    if (key !== own) {
      for (const state of states)
        for (const match of state.invertedIdx.fuzzyLookup(key, tolerance, prefixLength)) near.add(match.token)
    }
    for (const token of near) {
      if (excluded(token) || variants.includes(token)) continue
      if (partitionDocumentFrequency(states, token) > 0) typoMatches.push(token)
    }
    typoMatches.sort(compareCodePoints)
  }
  if (variants.length === 0 && typoMatches.length === 0) return null
  if (group !== undefined && variants.length > 0) {
    group.members = group.members.filter(member => member.token === own || !variants.includes(member.token))
  }
  return { token: own, variants, typoMatches, group: variants.length === 0 ? null : foldedGroupOf(own, variants) }
}

export function resolveFoldedPhrases(
  partition: PartitionIndex,
  language: LanguageModule,
  phrases: readonly AnalysedPhrase[],
): AnalysedPhrase[] {
  const rules = foldingRulesOf(language)
  const states = partition.readStates()
  return phrases.map(phrase => {
    const variants = phrase.tokens.map((own, at) =>
      variantsOf(states, rules, foldedSpelling(phrase.written?.[at] ?? own, rules).key, token => token === own),
    )
    return variants.some(found => found.length > 0) ? { ...phrase, variants } : phrase
  })
}

export function resolveFoldedTerms(request: FoldedTermRequest): FoldedQueryTerm[] | undefined {
  const rules = foldingRulesOf(request.language)
  const foldedTerms: FoldedQueryTerm[] = []
  for (const queryToken of request.queryTokens) {
    const group = request.termGroups?.find(candidate => candidate.token === queryToken.token)
    const folded = resolveTerm(request, rules, group, queryToken)
    if (folded !== null) foldedTerms.push(folded)
  }
  return foldedTerms.length === 0 ? undefined : foldedTerms
}
