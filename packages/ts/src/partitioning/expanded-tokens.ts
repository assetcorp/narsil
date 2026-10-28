import type { PartitionIndex } from '../core/partition'
import { tokenize } from '../core/tokenizer'
import { DEFAULT_FUZZY_PREFIX_LENGTH } from '../search/constants'
import { resolveTermGroups, type TermGroupAnalysis } from '../search/term-groups'
import type { LanguageModule } from '../types/language'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'

export interface StatsExpansion {
  tolerance?: number | null
  prefixLength?: number | null
  prefix?: boolean | null
  partialWords?: boolean | null
  exact?: boolean | null
  fields?: string[] | null
}

export interface QueryExpansion {
  options: StatsExpansion
  schema: SchemaDefinition
}

export interface ExpandedTokens {
  typoMatches: Set<string>
  capped: Set<string>
}

export function statsExpansionOf(params: StatsExpansion): StatsExpansion {
  return {
    tolerance: params.tolerance ?? null,
    prefixLength: params.prefixLength ?? null,
    prefix: params.prefix ?? null,
    partialWords: params.partialWords ?? null,
    exact: params.exact ?? null,
    fields: params.fields ?? null,
  }
}

type QueryToken = { token: string; position: number }

function queryTokensOf(
  term: string,
  language: LanguageModule,
  analysis: TermGroupAnalysis,
): { unique: QueryToken[]; last: QueryToken } | null {
  const { tokens } = tokenize(term, language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  })
  const seen = new Set<string>()
  const unique: QueryToken[] = []
  for (const token of tokens) {
    if (seen.has(token.token)) continue
    seen.add(token.token)
    unique.push(token)
  }
  return tokens.length === 0 ? null : { unique, last: tokens[tokens.length - 1] }
}

export function addExpandedTokens(
  into: ExpandedTokens,
  partition: PartitionIndex,
  term: string,
  expansion: QueryExpansion,
  language: LanguageModule,
  analysis: TermGroupAnalysis,
): void {
  const { options, schema } = expansion
  if (options.exact === true) return
  const analysed = queryTokensOf(term, language, analysis)
  if (analysed === null) return
  const { unique: queryTokens, last: lastToken } = analysed

  const tolerance = options.tolerance ?? 0
  const prefixLength = options.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH
  if (tolerance > 0) {
    for (const { token } of queryTokens) {
      for (const match of partition.typoTokens(token, tolerance, prefixLength)) into.typoMatches.add(match)
    }
  }

  const params: QueryParams = {
    term,
    tolerance,
    prefixLength,
    prefix: options.prefix ?? undefined,
    partialWords: options.partialWords ?? undefined,
    fields: options.fields ?? undefined,
  }
  const { termGroups } = resolveTermGroups(partition, params, language, schema, queryTokens, lastToken, analysis)
  for (const group of termGroups ?? []) {
    for (const member of group.members) {
      if (member.token !== group.token) into.capped.add(member.token)
    }
  }
}
