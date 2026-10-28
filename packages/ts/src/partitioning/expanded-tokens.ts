import type { PartitionIndex } from '../core/partition'
import { partitionStateOf } from '../core/partition'
import { isCompositePartition } from '../core/partition/composite'
import type { PartitionReadState } from '../core/partition/read-state'
import { tokenize } from '../core/tokenizer'
import { DEFAULT_FUZZY_PREFIX_LENGTH } from '../search/constants'
import { resolveTermGroups, type TermGroupAnalysis } from '../search/term-groups'
import type { LanguageModule } from '../types/language'
import type { QueryParams } from '../types/search'
import type { QueryExpansion } from './distributed-scoring'

type QueryToken = { token: string; position: number }

type AnalysedQuery = { unique: QueryToken[]; last: QueryToken }

function queryTokensOf(term: string, language: LanguageModule, analysis: TermGroupAnalysis): AnalysedQuery | null {
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

function readStatesOf(partition: PartitionIndex): PartitionReadState[] {
  if (!isCompositePartition(partition)) return [partitionStateOf(partition)]
  const segmentIds = partition.frozenSegmentSizes().map(segment => segment.segmentId)
  return [...partition.frozenSegmentsById(segmentIds), partitionStateOf(partition.live)]
}

function addPartitionTokens(
  tokens: Set<string>,
  capped: Set<string>,
  partition: PartitionIndex,
  term: string,
  analysed: AnalysedQuery,
  expansion: QueryExpansion,
  language: LanguageModule,
  analysis: TermGroupAnalysis,
): void {
  const { options, schema } = expansion
  const { unique: queryTokens, last: lastToken } = analysed
  const tolerance = options.tolerance ?? 0
  const prefixLength = options.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH
  if (tolerance > 0) {
    const states = readStatesOf(partition)
    for (const { token } of queryTokens) {
      for (const state of states) {
        for (const match of state.invertedIdx.fuzzyLookup(token, tolerance, prefixLength)) tokens.add(match.token)
      }
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
      if (member.token !== group.token) capped.add(member.token)
    }
  }
}

export function addReachedTokens(
  tokens: Set<string>,
  partitions: readonly PartitionIndex[],
  term: string,
  expansion: QueryExpansion,
  language: LanguageModule,
  analysis: TermGroupAnalysis,
): string[] {
  const { options } = expansion
  if (options.exact === true) return []
  if (!((options.tolerance ?? 0) > 0 || options.prefix === true || options.partialWords === true)) return []
  const analysed = queryTokensOf(term, language, analysis)
  if (analysed === null) return []
  const capped = new Set<string>()
  for (const partition of partitions) {
    addPartitionTokens(tokens, capped, partition, term, analysed, expansion, language, analysis)
  }
  for (const token of capped) tokens.add(token)
  return [...capped]
}
