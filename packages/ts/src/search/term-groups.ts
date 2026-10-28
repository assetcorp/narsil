import { codePointCount } from '../core/ordering/code-points'
import type { PartitionIndex } from '../core/partition'
import { addPartialWordMembers } from '../core/partition/partial-words/registry'
import type { PartialWordAnalysis } from '../core/partition/partial-words/spellings'
import type { QuerySynonyms } from '../core/synonyms/types'
import { tokenize } from '../core/tokenizer'
import { partialFieldsOf } from '../schema/validator'
import type { ExpandedTermGroup } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { CustomTokenizer, SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { PREFIX_MAX_EXPANSIONS } from './constants'

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

export function resolveTermGroups(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  queryTokens: readonly QueryToken[],
  lastToken: QueryToken,
  analysis?: TermGroupAnalysis,
  synonyms?: QuerySynonyms,
): ResolvedTermGroups {
  const term = params.term
  if (term === undefined || params.exact === true) return {}
  const usesPrefix = params.prefix === true
  const partialFields = params.partialWords === true ? partialFieldsOf(schema) : []
  const usesPartialWords = partialFields.length > 0 && searchesAPartialField(params, partialFields)
  if (!usesPrefix && !usesPartialWords && synonyms === undefined) return {}

  const written =
    usesPrefix || usesPartialWords ? writtenWordsByPosition(term, language, analysis) : new Map<number, string>()
  const groups = new Map<string, ExpandedTermGroup>()
  if (usesPrefix) addCompletions(groups, partition, lastToken, written.get(lastToken.position))
  const prefixToken = groups.has(lastToken.token) ? lastToken.token : undefined

  if (usesPartialWords) {
    addPartialWordMembers(
      {
        queryTokens,
        written,
        prefixToken,
        tolerance: params.tolerance ?? 0,
        prefixLength: params.prefixLength,
        analysis: partialWordAnalysisOf(partialFields, language, analysis),
      },
      (partialAnalysis, requests) => partition.expandPartialWords(partialAnalysis, requests),
      (token, typoMatches) => groupFor(groups, token, typoMatches),
    )
  }

  synonyms?.addTo(token => groupFor(groups, token, true))

  const termGroups = [...groups.values()]
  if (termGroups.length === 0) return {}
  return usesPartialWords ? { termGroups, partialFields: [...partialFields] } : { termGroups }
}
