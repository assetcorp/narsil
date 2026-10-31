import { type ResolvedAnalysis, resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import type { PendingAnalysisMetadata } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { IndexRegistryEntry } from '../core'

export interface AnalysisTarget {
  config: IndexConfig
  language: LanguageModule
  analysis: ResolvedAnalysis
}

export function targetOfPending(entry: IndexRegistryEntry, pending: PendingAnalysisMetadata): AnalysisTarget {
  const { tokenizer: _tokenizer, stopWords: _stopWords, ...rest } = entry.config
  const language = getLanguage(pending.language)
  const config: IndexConfig = {
    ...rest,
    language: pending.language,
    ...(pending.tokenizer !== undefined ? { tokenizer: pending.tokenizer } : {}),
    ...(pending.stopWords !== undefined ? { stopWords: pending.stopWords } : {}),
    ...(pending.stopWords === undefined && pending.stopWordList !== undefined
      ? { stopWords: new Set(pending.stopWordList) }
      : {}),
  }
  return { config, language, analysis: resolveIndexAnalysis(config) }
}
