import { platformSynonymSearch } from '#platform/synonym-search'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PostingListView } from '../../types/internal'
import type { SynonymRule, SynonymSearch } from '../../types/synonyms'
import type { RaiseSynonymProblem } from './rules'
import type { QuerySynonyms, SynonymAnalysis, SynonymLookup, SynonymSearchModule } from './types'

let registered: SynonymSearchModule | null = null

const MODULE_FUNCTIONS = ['buildLookup', 'expandQuery', 'combinePostings'] as const

function isSynonymSearchModule(value: SynonymSearch): value is SynonymSearchModule {
  if (value === null || typeof value !== 'object' || value.name !== 'synonyms') return false
  return MODULE_FUNCTIONS.every(name => typeof Reflect.get(value, name) === 'function')
}

/**
 * Call this to give the engine its synonym code, so that it can create and
 * load an index that holds a synonym set.
 *
 * A Node process loads that code by itself, so only a browser app has to make
 * this call. In a browser, import `synonyms` from `@delali/narsil/synonyms` and
 * pass it here before the app creates or loads an index with a synonym set.
 *
 * @param module - Pass the `synonyms` object that `@delali/narsil/synonyms`
 * exports.
 * @throws The engine throws a `NarsilError` with `CONFIG_INVALID` for any
 * other object.
 *
 * @public
 */
export function registerSynonyms(module: SynonymSearch): void {
  if (!isSynonymSearchModule(module)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Pass registerSynonyms the synonyms object that "@delali/narsil/synonyms" exports',
    )
  }
  registered = module
}

const SYNONYM_IMPORT_ADVICE = `Add import { synonyms } from '@delali/narsil/synonyms', then call registerSynonyms(synonyms) before you create or load an index with a synonym set`

function synonymModule(): SynonymSearchModule {
  const module = registered ?? platformSynonymSearch()
  if (module !== null) return module
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `This index holds a synonym set, but this bundle contains no synonym code. ${SYNONYM_IMPORT_ADVICE}`,
  )
}

export function buildSynonymLookup(
  rules: readonly SynonymRule[],
  analysis: SynonymAnalysis,
  raise: RaiseSynonymProblem | null,
): SynonymLookup | null {
  if (rules.length === 0) return null
  return synonymModule().buildLookup(rules, analysis, raise)
}

export function expandQuerySynonyms(
  lookup: SynonymLookup | null | undefined,
  queryTokens: Iterable<string>,
): QuerySynonyms | undefined {
  if (lookup === null || lookup === undefined) return undefined
  const expanded = synonymModule().expandQuery(lookup, queryTokens)
  return expanded.size === 0 ? undefined : expanded
}

export function combineSynonymPostings(lists: readonly PostingListView[]): PostingListView {
  return synonymModule().combinePostings(lists)
}
