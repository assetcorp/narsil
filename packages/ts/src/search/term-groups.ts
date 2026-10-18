import { codePointCount } from '../core/ordering/code-points'
import type { PartitionIndex } from '../core/partition'
import type { PartialWordAnalysis } from '../core/partition/partial-words/spellings'
import type { AddedWord, PartialWordRequest } from '../core/partition/partial-words/types'
import { tokenize } from '../core/tokenizer'
import { partialFieldsOf } from '../schema/validator'
import type { ExpandedTermGroup, ExpandedTermMember } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { CustomTokenizer, SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import {
  DEFAULT_FUZZY_PREFIX_LENGTH,
  PARTIAL_WORD_MIN_CODE_POINTS,
  PARTIAL_WORDS_ADDED_PER_QUERY,
  PREFIX_MAX_EXPANSIONS,
} from './constants'

export interface TermGroupAnalysis {
  stopWords?: Set<string> | ((defaults: Set<string>) => Set<string>)
  customTokenizer?: CustomTokenizer
}

export interface ResolvedTermGroups {
  termGroups?: ExpandedTermGroup[]
  partialFields?: string[]
}

type QueryToken = { token: string; position: number }

function writtenWordsByPosition(
  term: string,
  language: LanguageModule,
  analysis: TermGroupAnalysis | undefined,
): Map<number, string> {
  const unstemmed = tokenize(term, language, {
    stem: false,
    removeStopWords: true,
    customTokenizer: analysis?.customTokenizer,
    stopWordOverride: analysis?.stopWords,
  })
  const written = new Map<number, string>()
  for (const token of unstemmed.tokens) {
    if (!written.has(token.position)) written.set(token.position, token.token)
  }
  return written
}

function groupFor(groups: Map<string, ExpandedTermGroup>, token: string, typoMatches: boolean): ExpandedTermGroup {
  let group = groups.get(token)
  if (group === undefined) {
    group = { token, members: [{ token, factor: 1, partialFactor: 1 }], typoMatches }
    groups.set(token, group)
  }
  return group
}

function addCompletions(
  groups: Map<string, ExpandedTermGroup>,
  partition: PartitionIndex,
  lastToken: QueryToken,
  typedPrefix: string | undefined,
): void {
  if (typedPrefix === undefined || typedPrefix.length === 0) return
  const group = groupFor(groups, lastToken.token, false)
  const ownLength = codePointCount(lastToken.token)
  for (const completion of partition.expandTermPrefix(typedPrefix, lastToken.token, PREFIX_MAX_EXPANSIONS)) {
    if (completion === lastToken.token) continue
    const factor = Math.min(1, ownLength / codePointCount(completion))
    group.members.push({ token: completion, factor, partialFactor: factor })
  }
}

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

function partialWordAnalysisOf(
  fields: readonly string[],
  language: LanguageModule,
  analysis: TermGroupAnalysis | undefined,
): PartialWordAnalysis {
  return {
    fields,
    language,
    options: {
      stopWordOverride: analysis?.stopWords,
      customTokenizer: analysis?.customTokenizer,
      collectSurfaces: true,
    },
  }
}

function searchesAPartialField(params: QueryParams, partialFields: readonly string[]): boolean {
  if (params.fields === undefined) return true
  for (const field of params.fields) {
    if (partialFields.includes(field)) return true
  }
  return false
}

function partialWordRequests(
  params: QueryParams,
  queryTokens: readonly QueryToken[],
  written: ReadonlyMap<number, string>,
  prefixToken: string | undefined,
): Array<{ token: string; request: PartialWordRequest }> {
  const eligible: Array<{ token: string; written: string }> = []
  for (const queryToken of queryTokens) {
    const word = written.get(queryToken.position)
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
      tolerance: entry.token === prefixToken ? 0 : (params.tolerance ?? 0),
      prefixLength: params.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
    },
  }))
}

export function resolveTermGroups(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  queryTokens: readonly QueryToken[],
  lastToken: QueryToken,
  analysis?: TermGroupAnalysis,
): ResolvedTermGroups {
  const term = params.term
  if (term === undefined || params.exact === true) return {}
  const usesPrefix = params.prefix === true
  const partialFields = params.partialWords === true ? partialFieldsOf(schema) : []
  const usesPartialWords = partialFields.length > 0 && searchesAPartialField(params, partialFields)
  if (!usesPrefix && !usesPartialWords) return {}

  const written = writtenWordsByPosition(term, language, analysis)
  const groups = new Map<string, ExpandedTermGroup>()
  if (usesPrefix) addCompletions(groups, partition, lastToken, written.get(lastToken.position))
  const prefixToken = groups.has(lastToken.token) ? lastToken.token : undefined

  if (usesPartialWords) {
    const requests = partialWordRequests(params, queryTokens, written, prefixToken)
    const added = partition.expandPartialWords(
      partialWordAnalysisOf(partialFields, language, analysis),
      requests.map(entry => entry.request),
    )
    for (let at = 0; at < requests.length; at++) {
      if (added[at].length === 0) continue
      const token = requests[at].token
      addPartialWords(groupFor(groups, token, token !== prefixToken), added[at])
    }
  }

  const termGroups = [...groups.values()]
  if (termGroups.length === 0) return {}
  return usesPartialWords ? { termGroups, partialFields: [...partialFields] } : { termGroups }
}
