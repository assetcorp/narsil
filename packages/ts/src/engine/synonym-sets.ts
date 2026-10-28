import { resolveIndexAnalysis } from '../analysis/registry'
import { encodeSynonymRules } from '../core/synonyms/registry'
import {
  type PreparedSynonyms,
  prepareSynonyms,
  raiseConfigInvalid,
  storedSynonymLookup,
} from '../core/synonyms/stored'
import type { SynonymAnalysis, SynonymLookup } from '../core/synonyms/types'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { SynonymRule } from '../types/synonyms'

export function synonymAnalysisOf(config: IndexConfig, language: LanguageModule): SynonymAnalysis {
  return { language, ...resolveIndexAnalysis(config) }
}

export function withoutSynonyms(config: IndexConfig): IndexConfig {
  if (!Object.hasOwn(config, 'synonyms')) return config
  const { synonyms: _synonyms, ...rest } = config
  return rest
}

export function prepareConfiguredSynonyms(
  config: IndexConfig,
  language: LanguageModule,
  strictWords = true,
): PreparedSynonyms | null {
  if (config.synonyms === undefined) return null
  return prepareSynonyms(config.synonyms, synonymAnalysisOf(config, language), raiseConfigInvalid, strictWords)
}

export function encodeStoredSynonyms(rules: readonly SynonymRule[] | undefined): Uint8Array | null {
  return rules === undefined || rules.length === 0 ? null : encodeSynonymRules(rules)
}

export function lookupOfStoredSynonyms(
  encoded: Uint8Array | null,
  config: IndexConfig,
  language: LanguageModule,
): SynonymLookup | null {
  return encoded === null ? null : storedSynonymLookup(encoded, synonymAnalysisOf(config, language))
}
