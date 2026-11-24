import { getLanguage, resolveIndexAnalysis } from '#platform/storage-host'
import type { ResolvedAnalysis } from '../../analysis/registry'
import type { NamedAnalysisSettings, PendingAnalysisMetadata } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { IndexRegistryEntry } from '../core'

export interface AnalysisTarget {
  config: IndexConfig
  language: LanguageModule
  analysis: ResolvedAnalysis
}

export type AnalysisMembers = Pick<IndexConfig, 'tokenizer' | 'stopWords' | 'foldMarks'>

export function configUnderAnalysis(base: IndexConfig, language: string, members: AnalysisMembers): IndexConfig {
  const { tokenizer: _tokenizer, stopWords: _stopWords, foldMarks: _foldMarks, ...rest } = base
  return {
    ...rest,
    language,
    ...(members.tokenizer !== undefined ? { tokenizer: members.tokenizer } : {}),
    ...(members.stopWords !== undefined ? { stopWords: members.stopWords } : {}),
    ...(members.foldMarks !== undefined ? { foldMarks: members.foldMarks } : {}),
  }
}

export function configOfNamedSettings(base: IndexConfig, settings: NamedAnalysisSettings): IndexConfig {
  const { language, tokenizer, stopWords, stopWordList, foldMarks } = settings
  const listed = stopWordList === undefined ? undefined : new Set(stopWordList)
  return configUnderAnalysis(base, language, { tokenizer, stopWords: stopWords ?? listed, foldMarks })
}

export function targetOfPending(entry: IndexRegistryEntry, pending: PendingAnalysisMetadata): AnalysisTarget {
  const config = configOfNamedSettings(entry.config, pending)
  return { config, language: getLanguage(pending.language), analysis: resolveIndexAnalysis(config) }
}
