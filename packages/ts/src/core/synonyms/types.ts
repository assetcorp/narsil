import type { PostingListView } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { CustomTokenizer, StopWordOverride } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import type { RaiseSynonymProblem } from './rules'

export interface SynonymAnalysis {
  language: LanguageModule
  stopWords?: StopWordOverride
  customTokenizer?: CustomTokenizer
}

export interface SynonymLookup {
  synonymsOf(token: string): readonly string[]
  readonly tokenCount: number
  readonly bytes: number
}

export type QuerySynonyms = ReadonlyMap<string, readonly string[]>

export interface SynonymSearchModule {
  readonly name: 'synonyms'
  buildLookup(
    rules: readonly SynonymRule[],
    analysis: SynonymAnalysis,
    raise: RaiseSynonymProblem | null,
  ): SynonymLookup | null
  expandQuery(lookup: SynonymLookup, queryTokens: Iterable<string>): QuerySynonyms
  combinePostings(lists: readonly PostingListView[]): PostingListView
  parseRules(value: unknown, raise: RaiseSynonymProblem): SynonymRule[]
  encodeRules(rules: readonly SynonymRule[]): Uint8Array
  decodeRules(bytes: Uint8Array, raise: RaiseSynonymProblem): SynonymRule[]
}
