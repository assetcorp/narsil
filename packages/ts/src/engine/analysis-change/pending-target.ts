import { type ResolvedAnalysis, resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import type { NamedAnalysisSettings, PendingAnalysisMetadata } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { IndexRegistryEntry } from '../core'

export interface AnalysisTarget {
  config: IndexConfig
  language: LanguageModule
  analysis: ResolvedAnalysis
}

export function configUnderAnalysis(
  base: IndexConfig,
  language: string,
  tokenizer: IndexConfig['tokenizer'],
  stopWords: IndexConfig['stopWords'],
): IndexConfig {
  const { tokenizer: _tokenizer, stopWords: _stopWords, ...rest } = base
  return {
    ...rest,
    language,
    ...(tokenizer !== undefined ? { tokenizer } : {}),
    ...(stopWords !== undefined ? { stopWords } : {}),
  }
}

export function configOfNamedSettings(base: IndexConfig, settings: NamedAnalysisSettings): IndexConfig {
  const { language, tokenizer, stopWords, stopWordList } = settings
  const listed = stopWordList === undefined ? undefined : new Set(stopWordList)
  return configUnderAnalysis(base, language, tokenizer, stopWords ?? listed)
}

export function targetOfPending(entry: IndexRegistryEntry, pending: PendingAnalysisMetadata): AnalysisTarget {
  const config = configOfNamedSettings(entry.config, pending)
  return { config, language: getLanguage(pending.language), analysis: resolveIndexAnalysis(config) }
}
