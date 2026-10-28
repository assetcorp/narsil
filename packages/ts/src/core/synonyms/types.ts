import type { EngineCore } from '../../engine/core'
import type { ExpandedTermGroup, PostingListView } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { CustomTokenizer, IndexConfig, StopWordOverride } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'

export type RaiseSynonymProblem = (message: string, details: Record<string, unknown>) => never

export interface SynonymAnalysis {
  language: LanguageModule
  stopWords?: StopWordOverride
  customTokenizer?: CustomTokenizer
}

export interface GroupSynonyms {
  readonly tokens: readonly string[]
  has(token: string): boolean
  documentFrequency(frequencyOf: (token: string) => number): number
  postings(lookup: (token: string) => PostingListView | undefined, own: string): PostingListView | undefined
}

export interface QuerySynonyms {
  readonly tokens: readonly string[]
  addTo(groupOf: (token: string) => ExpandedTermGroup): void
}

export interface SynonymLookup {
  synonymsOf(token: string): readonly string[]
  expand(queryTokens: Iterable<string>): QuerySynonyms | undefined
  readonly tokenCount: number
  readonly bytes: number
}

export interface PreparedSynonyms {
  encoded: Uint8Array
  lookup: SynonymLookup | null
}

export interface SynonymSearchModule {
  readonly name: 'synonyms'
  prepare(
    value: unknown,
    config: IndexConfig,
    language: LanguageModule,
    strictWords: boolean,
    raise?: RaiseSynonymProblem | string,
  ): PreparedSynonyms | null
  storedLookup(encoded: Uint8Array, config: IndexConfig, language: LanguageModule): SynonymLookup | null
  decodeRules(bytes: Uint8Array): SynonymRule[]
  replace(core: EngineCore, indexName: string, value: unknown, strictWords: boolean): Promise<void>
  applyLoaded(core: EngineCore, indexName: string, load: () => Promise<readonly SynonymRule[] | null>): Promise<boolean>
}
