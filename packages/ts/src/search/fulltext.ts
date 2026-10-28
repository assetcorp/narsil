import { bitsetIsEmpty } from '../core/bitset'
import { fuzzyTermMatches } from '../core/fuzzy'
import type { PartitionIndex, PartitionSearchMatches } from '../core/partition'
import type { PatternWorkMeter } from '../core/pattern-index/types'
import { createPatternWorkMeter } from '../core/pattern-index/work-meter'
import type { SynonymLookup } from '../core/synonyms/types'
import { tokenize } from '../core/tokenizer'
import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema, isWordIndexedFieldType } from '../schema/validator'
import type { ExpandedTermGroup, GlobalStatistics, InternalSearchResult, ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { BM25Params, CustomTokenizer, FieldType, SchemaDefinition } from '../types/schema'
import type { QueryParams, TermMatchPolicy } from '../types/search'
import { DEFAULT_FUZZY_PREFIX_LENGTH, DEFAULT_PAGE_SIZE } from './constants'
import { clampRowCount } from './pagination'
import { type ResolvedTermGroups, resolveTermGroups } from './term-groups'

export interface FulltextSearchOptions {
  bm25Params?: BM25Params
  stopWords?: Set<string> | ((defaults: Set<string>) => Set<string>)
  customTokenizer?: CustomTokenizer
  globalStats?: GlobalStatistics
  patternWork?: PatternWorkMeter
  synonyms?: SynonymLookup | null
}

interface PreparedFulltextQuery extends ResolvedTermGroups {
  queryTokens: Array<{ token: string; position: number }>
  filterBitset?: Uint32Array
}

function prepareFulltextQuery(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: FulltextSearchOptions,
): PreparedFulltextQuery | null {
  if (!params.term || params.term.trim().length === 0) return null
  if (params.fields && params.fields.length === 0) return null

  const flatSchema = flattenSchema(schema)

  if (params.fields) {
    validateSearchFields(params.fields, flatSchema)
  }

  const queryTokenResult = tokenize(params.term, language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: options?.customTokenizer,
    stopWordOverride: options?.stopWords,
  })

  if (queryTokenResult.tokens.length === 0) return null

  const queryTokens = deduplicateTokens(queryTokenResult.tokens)

  let filterBitset: Uint32Array | undefined
  if (params.filters) {
    filterBitset = partition.applyFiltersBitset(
      params.filters,
      schema,
      options?.patternWork ?? createPatternWorkMeter(),
    )
    if (bitsetIsEmpty(filterBitset)) return null
  }

  const lastToken = queryTokenResult.tokens[queryTokenResult.tokens.length - 1]
  const synonyms = params.exact === true ? undefined : options?.synonyms?.expand(queryTokens.map(qt => qt.token))
  const groups = resolveTermGroups(partition, params, language, schema, queryTokens, lastToken, options, synonyms)
  return { queryTokens, ...groups, filterBitset }
}

/**
 * Finds the documents of one partition that a full-text query matches, without
 * computing a single relevance score. A sorted query without `includeScores`
 * feeds the result to the partition's sort columns as its match filter.
 *
 * @param partition - The partition to match against.
 * @param params - The query, of which the matching inputs are read: term, fields, filters, tolerance, prefix, and exact.
 * @param language - The language module the index analyses text with.
 * @param schema - The index schema, read for field validation and filters.
 * @param options - The index's tokenizer and stop-word configuration.
 * @returns The matches, or null when the query provably matches nothing.
 */
export function fulltextMatches(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: FulltextSearchOptions,
): PartitionSearchMatches | null {
  const prepared = prepareFulltextQuery(partition, params, language, schema, options)
  if (prepared === null) return null

  return partition.searchFulltextMatches({
    queryTokens: prepared.queryTokens,
    termGroups: prepared.termGroups,
    partialFields: prepared.partialFields,
    fields: params.fields,
    tolerance: params.tolerance ?? 0,
    prefixLength: params.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
    exact: params.exact ?? false,
    filterBitset: prepared.filterBitset,
  })
}

export function fulltextSearch(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: FulltextSearchOptions,
): InternalSearchResult {
  const prepared = prepareFulltextQuery(partition, params, language, schema, options)
  if (prepared === null) {
    return { scored: [], totalMatched: 0 }
  }
  const { queryTokens, termGroups, partialFields, filterBitset } = prepared

  const needsAllResults =
    params.minScore !== undefined ||
    (params.termMatch !== undefined && params.termMatch !== 'any') ||
    params.sort !== undefined ||
    params.group !== undefined ||
    params.pinned !== undefined ||
    params.searchAfter !== undefined
  const maxResults = needsAllResults
    ? undefined
    : clampRowCount(params.limit, DEFAULT_PAGE_SIZE) + clampRowCount(params.offset, 0) + 1
  const collectMatchedSet = params.facets !== undefined && !needsAllResults ? ('ordinals' as const) : undefined

  const collectComponents =
    params.includeScoreComponents === true || (params.termMatch !== undefined && params.termMatch !== 'any')

  const rawResult = partition.searchFulltext({
    queryTokens,
    termGroups,
    partialFields,
    fields: params.fields,
    boost: params.boost,
    tolerance: params.tolerance ?? 0,
    prefixLength: params.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
    exact: params.exact ?? false,
    bm25Params: options?.bm25Params,
    globalStats: options?.globalStats,
    maxResults,
    termMatch: params.termMatch,
    filterBitset,
    collectComponents,
    collectMatchedSet,
  })

  let scored = rawResult.scored

  const termMatch = params.termMatch ?? 'any'
  if (termMatch !== 'any') {
    scored = filterByTermCoverage(
      scored,
      queryTokens,
      termMatch,
      params.tolerance ?? 0,
      params.prefixLength ?? DEFAULT_FUZZY_PREFIX_LENGTH,
      params.exact ?? false,
      termGroups,
      partialFields ?? [],
    )
  }

  if (params.minScore !== undefined && params.minScore > 0) {
    const threshold = params.minScore
    scored = scored.filter(doc => doc.score >= threshold)
  }

  const totalMatched = needsAllResults ? scored.length : rawResult.totalMatched
  if (params.facets === undefined) {
    return { scored, totalMatched }
  }
  if (needsAllResults) {
    return { scored, totalMatched, matchedIds: scored.map(doc => doc.docId) }
  }
  return { scored, totalMatched, matchedOrdinalBitset: rawResult.matchedOrdinalBitset }
}

function validateSearchFields(fields: string[], flatSchema: Record<string, FieldType>): void {
  for (const field of fields) {
    const fieldType = flatSchema[field]
    if (!fieldType) {
      throw new NarsilError(ErrorCodes.SEARCH_INVALID_FIELD, `Field "${field}" does not exist in the schema`, { field })
    }
    if (!isWordIndexedFieldType(fieldType)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `Field "${field}" has type "${fieldType}" which cannot be used for full-text search`,
        { field, fieldType },
      )
    }
  }
}

function deduplicateTokens(
  tokens: Array<{ token: string; position: number }>,
): Array<{ token: string; position: number }> {
  const seen = new Set<string>()
  const result: Array<{ token: string; position: number }> = []
  for (const t of tokens) {
    if (!seen.has(t.token)) {
      seen.add(t.token)
      result.push(t)
    }
  }
  return result
}

function filterByTermCoverage(
  scored: ScoredDocument[],
  queryTokens: Array<{ token: string; position: number }>,
  policy: TermMatchPolicy,
  tolerance: number,
  prefixLength: number,
  exact: boolean,
  termGroups: readonly ExpandedTermGroup[] | undefined,
  partialFields: readonly string[],
): ScoredDocument[] {
  const requiredCount = policy === 'all' ? queryTokens.length : (policy as number)

  if (requiredCount <= 0) return scored
  if (requiredCount > queryTokens.length) return []

  const groups = new Map<string, CoverageGroup>()
  for (const group of termGroups ?? []) {
    const partialOnly = new Set<string>()
    for (const member of group.members) {
      if (member.factor === 0) partialOnly.add(member.token)
    }
    groups.set(group.token, {
      members: new Set([...group.members.map(member => member.token), ...(group.synonyms?.tokens ?? [])]),
      partialOnly,
      typoMatches: group.typoMatches,
    })
  }

  return scored.filter(doc => {
    const matched = countDocTermMatches(doc, queryTokens, tolerance, prefixLength, exact, groups, partialFields)
    return matched >= requiredCount
  })
}

interface CoverageGroup {
  members: ReadonlySet<string>
  partialOnly: ReadonlySet<string>
  typoMatches: boolean
}

function countDocTermMatches(
  doc: ScoredDocument,
  queryTokens: Array<{ token: string; position: number }>,
  tolerance: number,
  prefixLength: number,
  exact: boolean,
  groups: ReadonlyMap<string, CoverageGroup>,
  partialFields: readonly string[],
): number {
  const indexTokens = Object.keys(doc.idf)
  if (indexTokens.length === 0) return 0

  let count = 0
  for (const qt of queryTokens) {
    const group = groups.get(qt.token)
    const satisfied =
      group === undefined
        ? queryTermSatisfied(qt.token, indexTokens, tolerance, prefixLength, exact)
        : groupSatisfied(group, doc, indexTokens, partialFields) ||
          (group.typoMatches && queryTermSatisfied(qt.token, indexTokens, tolerance, prefixLength, exact))
    if (satisfied) count++
  }
  return count
}

function matchedInPartialField(doc: ScoredDocument, token: string, partialFields: readonly string[]): boolean {
  for (const field of partialFields) {
    if (doc.termFrequencies[`${field}:${token}`] !== undefined) return true
  }
  return false
}

function groupSatisfied(
  group: CoverageGroup,
  doc: ScoredDocument,
  indexTokens: readonly string[],
  partialFields: readonly string[],
): boolean {
  for (const indexToken of indexTokens) {
    if (!group.members.has(indexToken)) continue
    if (!group.partialOnly.has(indexToken) || matchedInPartialField(doc, indexToken, partialFields)) return true
  }
  return false
}

function queryTermSatisfied(
  queryToken: string,
  indexTokens: string[],
  tolerance: number,
  prefixLength: number,
  exact: boolean,
): boolean {
  if (exact || tolerance === 0) {
    return indexTokens.includes(queryToken)
  }

  for (const indexToken of indexTokens) {
    if (fuzzyTermMatches(queryToken, indexToken, tolerance, prefixLength)) {
      return true
    }
  }
  return false
}
