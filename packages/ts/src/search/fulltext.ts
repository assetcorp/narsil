import { bitsetIsEmpty } from '../core/bitset'
import { boundedLevenshtein } from '../core/fuzzy'
import type { PartitionIndex } from '../core/partition'
import { tokenize } from '../core/tokenizer'
import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema } from '../schema/validator'
import type { GlobalStatistics, InternalSearchResult, ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { BM25Params, CustomTokenizer, FieldType, SchemaDefinition } from '../types/schema'
import type { QueryParams, TermMatchPolicy } from '../types/search'

export interface FulltextSearchOptions {
  bm25Params?: BM25Params
  stopWords?: Set<string> | ((defaults: Set<string>) => Set<string>)
  customTokenizer?: CustomTokenizer
  globalStats?: GlobalStatistics
}

const PREFIX_MAX_EXPANSIONS = 50

function resolvePrefixExpansion(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  options: FulltextSearchOptions | undefined,
  queryTokens: Array<{ token: string; position: number }>,
  lastToken: { token: string; position: number },
): { token: string; terms: string[] } | undefined {
  const term = params.term
  if (term === undefined) return undefined

  const unstemmed = tokenize(term, language, {
    stem: false,
    removeStopWords: true,
    customTokenizer: options?.customTokenizer,
    stopWordOverride: options?.stopWords,
  })

  let surfacePrefix: string | undefined
  for (const t of unstemmed.tokens) {
    if (t.position === lastToken.position) {
      surfacePrefix = t.token
      break
    }
  }
  if (surfacePrefix === undefined || surfacePrefix.length === 0) return undefined

  const expansions = partition.expandTermPrefix(surfacePrefix, lastToken.token, PREFIX_MAX_EXPANSIONS)
  const terms: string[] = []
  for (const expanded of expansions) {
    if (expanded !== lastToken.token) terms.push(expanded)
  }

  for (const qt of queryTokens) {
    if (qt.token === lastToken.token) {
      return { token: qt.token, terms }
    }
  }
  return undefined
}

export function fulltextSearch(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: FulltextSearchOptions,
): InternalSearchResult {
  if (!params.term || params.term.trim().length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  if (params.fields && params.fields.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

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

  if (queryTokenResult.tokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const queryTokens = deduplicateTokens(queryTokenResult.tokens)

  let prefixExpansion: { token: string; terms: string[] } | undefined
  if (params.prefix === true && params.exact !== true) {
    const lastToken = queryTokenResult.tokens[queryTokenResult.tokens.length - 1]
    prefixExpansion = resolvePrefixExpansion(partition, params, language, options, queryTokens, lastToken)
  }

  let filterBitset: Uint32Array | undefined
  if (params.filters) {
    filterBitset = partition.applyFiltersBitset(params.filters, schema)
    if (bitsetIsEmpty(filterBitset)) {
      return { scored: [], totalMatched: 0 }
    }
  }

  const needsAllResults =
    params.minScore !== undefined ||
    (params.termMatch !== undefined && params.termMatch !== 'any') ||
    params.sort !== undefined ||
    params.group !== undefined ||
    params.pinned !== undefined ||
    params.searchAfter !== undefined
  const requestedLimit =
    params.limit !== undefined || params.offset !== undefined
      ? (params.limit ?? 10) + (params.offset ?? 0) + 1
      : undefined
  const maxResults = requestedLimit !== undefined && !needsAllResults ? requestedLimit : undefined

  const collectComponents =
    params.includeScoreComponents === true || (params.termMatch !== undefined && params.termMatch !== 'any')

  const rawResult = partition.searchFulltext({
    queryTokens,
    prefixExpansion,
    fields: params.fields,
    boost: params.boost,
    tolerance: params.tolerance ?? 0,
    prefixLength: params.prefixLength ?? 2,
    exact: params.exact ?? false,
    bm25Params: options?.bm25Params,
    globalStats: options?.globalStats,
    maxResults,
    termMatch: params.termMatch,
    filterBitset,
    collectComponents,
  })

  let scored = rawResult.scored

  const termMatch = params.termMatch ?? 'any'
  if (termMatch !== 'any') {
    scored = filterByTermCoverage(
      scored,
      queryTokens,
      termMatch,
      params.tolerance ?? 0,
      params.exact ?? false,
      prefixExpansion,
    )
  }

  if (params.minScore !== undefined && params.minScore > 0) {
    const threshold = params.minScore
    scored = scored.filter(doc => doc.score >= threshold)
  }

  const totalMatched = needsAllResults ? scored.length : rawResult.totalMatched
  return { scored, totalMatched }
}

function validateSearchFields(fields: string[], flatSchema: Record<string, FieldType>): void {
  for (const field of fields) {
    const fieldType = flatSchema[field]
    if (!fieldType) {
      throw new NarsilError(ErrorCodes.SEARCH_INVALID_FIELD, `Field "${field}" does not exist in the schema`, { field })
    }
    if (fieldType !== 'string' && fieldType !== 'string[]') {
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
  exact: boolean,
  prefixExpansion?: { token: string; terms: string[] },
): ScoredDocument[] {
  const requiredCount = policy === 'all' ? queryTokens.length : (policy as number)

  if (requiredCount <= 0) return scored
  if (requiredCount > queryTokens.length) return []

  const expansionTerms = prefixExpansion ? new Set(prefixExpansion.terms) : undefined

  return scored.filter(doc => {
    const matched = countDocTermMatches(doc, queryTokens, tolerance, exact, prefixExpansion?.token, expansionTerms)
    return matched >= requiredCount
  })
}

function countDocTermMatches(
  doc: ScoredDocument,
  queryTokens: Array<{ token: string; position: number }>,
  tolerance: number,
  exact: boolean,
  prefixToken?: string,
  expansionTerms?: Set<string>,
): number {
  const indexTokens = Object.keys(doc.idf)
  if (indexTokens.length === 0) return 0

  let count = 0
  for (const qt of queryTokens) {
    if (prefixToken !== undefined && qt.token === prefixToken) {
      if (prefixTokenSatisfied(qt.token, indexTokens, expansionTerms)) {
        count++
      }
      continue
    }
    if (queryTermSatisfied(qt.token, indexTokens, tolerance, exact)) {
      count++
    }
  }
  return count
}

function prefixTokenSatisfied(prefixToken: string, indexTokens: string[], expansionTerms?: Set<string>): boolean {
  for (const indexToken of indexTokens) {
    if (indexToken === prefixToken) return true
    if (expansionTerms?.has(indexToken)) return true
  }
  return false
}

function queryTermSatisfied(queryToken: string, indexTokens: string[], tolerance: number, exact: boolean): boolean {
  if (exact || tolerance === 0) {
    return indexTokens.includes(queryToken)
  }

  for (const indexToken of indexTokens) {
    if (boundedLevenshtein(queryToken, indexToken, tolerance).withinTolerance) {
      return true
    }
  }
  return false
}
