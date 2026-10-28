import { isEmptySynonymSet, synonymModule } from '../core/synonyms/registry'
import type { PreparedSynonyms, RaiseSynonymProblem, SynonymLookup } from '../core/synonyms/types'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { SynonymRule } from '../types/synonyms'

export function withoutSynonyms(config: IndexConfig): IndexConfig {
  if (!Object.hasOwn(config, 'synonyms')) return config
  const { synonyms: _synonyms, ...rest } = config
  return rest
}

export function prepareStoredSynonyms(
  value: unknown,
  config: IndexConfig,
  language: LanguageModule,
  raise?: RaiseSynonymProblem | string,
  strictWords = false,
): PreparedSynonyms | null {
  return isEmptySynonymSet(value) ? null : synonymModule().prepare(value, config, language, strictWords, raise)
}

export function prepareConfiguredSynonyms(
  config: IndexConfig,
  language: LanguageModule,
  strictWords = true,
): PreparedSynonyms | null {
  return prepareStoredSynonyms(config.synonyms, config, language, undefined, strictWords)
}

export function lookupOfStoredSynonyms(
  encoded: Uint8Array | null | undefined,
  config: IndexConfig,
  language: LanguageModule,
): SynonymLookup | null {
  return encoded === null || encoded === undefined ? null : synonymModule().storedLookup(encoded, config, language)
}

export function rulesOfStoredSynonyms(encoded: Uint8Array | null): SynonymRule[] {
  return encoded === null ? [] : synonymModule().decodeRules(encoded)
}
