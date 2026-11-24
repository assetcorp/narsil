import {
  ANALYSIS_CHANGE_MEMBERS,
  compareCodePoints,
  ErrorCodes,
  getLanguage,
  NarsilError,
  prepareConfiguredSynonyms,
  resolveIndexAnalysis,
  rulesOfStoredSynonyms,
} from '#platform/storage-host'
import type { AnalysisChange } from '../../types/analysis-operations'
import type { NamedAnalysisSettings } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { DurableAnalysis, IndexRegistryEntry } from '../core'
import { requireConfigurationWithinSizeLimit } from '../snapshot/index-configuration-limit'
import type { AnalysisTarget } from './pending-target'
import { configUnderAnalysis } from './pending-target'

export type { AnalysisTarget } from './pending-target'

function refuseTokenizer(indexName: string): never {
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The tokenizer of index "${indexName}" must change to a name registered with registerTokenizer, because an instance survives neither a worker boundary nor a restart`,
    { indexName },
  )
}

function refuseStopWords(indexName: string): never {
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The stop words of index "${indexName}" must change to a name registered with registerStopWords or to a list of words, because a function survives neither a worker boundary nor a restart`,
    { indexName },
  )
}

function stopWordsOfChange(indexName: string, value: unknown): string | Set<string> | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') return value
  const words = value instanceof Set ? [...value] : value
  if (!Array.isArray(words) || words.some(word => typeof word !== 'string')) refuseStopWords(indexName)
  return new Set(words as string[])
}

function tokenizerOfChange(indexName: string, value: unknown): string | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') return value
  refuseTokenizer(indexName)
}

function foldMarksOfChange(indexName: string, value: unknown): boolean | null | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return value
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The foldMarks of index "${indexName}" must be true, false, or null`,
    {
      indexName,
    },
  )
}

function requireRegisteredLanguage(name: unknown): LanguageModule {
  if (typeof name !== 'string') {
    throw new NarsilError(ErrorCodes.LANGUAGE_NOT_SUPPORTED, 'The language of an analysis change must be a name')
  }
  return getLanguage(name)
}

export function resolveAnalysisTarget(indexName: string, base: IndexConfig, change: AnalysisChange): AnalysisTarget {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'An analysis change must be an object', { indexName })
  }
  const unknownMember = Object.keys(change).find(member => !ANALYSIS_CHANGE_MEMBERS.includes(member))
  if (unknownMember !== undefined) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `"${unknownMember}" is not an analysis setting`, { indexName })
  }
  const language =
    change.language === undefined ? getLanguage(base.language ?? 'english') : requireRegisteredLanguage(change.language)
  const tokenizer = tokenizerOfChange(indexName, change.tokenizer)
  const stopWords = stopWordsOfChange(indexName, change.stopWords)
  const foldMarks = foldMarksOfChange(indexName, change.foldMarks)
  const config = configUnderAnalysis(base, language.name, {
    tokenizer: tokenizer === undefined ? base.tokenizer : (tokenizer ?? undefined),
    stopWords: stopWords === undefined ? base.stopWords : (stopWords ?? undefined),
    foldMarks: foldMarks === undefined ? base.foldMarks : (foldMarks ?? undefined),
  })
  requireConfigurationWithinSizeLimit(config, language)
  return { config, language, analysis: resolveIndexAnalysis(config) }
}

export function currentConfigUnderTarget(current: IndexConfig, target: AnalysisTarget): IndexConfig {
  return configUnderAnalysis(current, target.language.name, target.config)
}

function sameStopWords(left: IndexConfig['stopWords'], right: IndexConfig['stopWords']): boolean {
  if (left === right) return true
  if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false
  for (const word of left) if (!right.has(word)) return false
  return true
}

export function holdsTerms(config: IndexConfig, target: AnalysisTarget): boolean {
  return (
    (config.language ?? 'english') === target.language.name &&
    config.tokenizer === target.config.tokenizer &&
    sameStopWords(config.stopWords, target.config.stopWords)
  )
}

export function holdsSettings(config: IndexConfig, target: AnalysisTarget): boolean {
  return holdsTerms(config, target) && config.foldMarks === target.config.foldMarks
}

export function namedSettingsOf(config: IndexConfig, language: string): NamedAnalysisSettings {
  return {
    language,
    ...(typeof config.tokenizer === 'string' ? { tokenizer: config.tokenizer } : {}),
    ...(typeof config.stopWords === 'string' ? { stopWords: config.stopWords } : {}),
    ...(config.stopWords instanceof Set ? { stopWordList: [...config.stopWords].sort(compareCodePoints) } : {}),
    ...(typeof config.foldMarks === 'boolean' ? { foldMarks: config.foldMarks } : {}),
  }
}

export function durableSettingsOf(entry: IndexRegistryEntry, rewritesTerms: boolean): DurableAnalysis {
  return {
    ...namedSettingsOf(entry.config, entry.language.name),
    generation: entry.analysisGeneration,
    analysisRevision: entry.analysisRevision,
    arrayPositionGap: entry.arrayPositionGap,
    rewritesTerms,
  }
}

export function requireSynonymsUnderTarget(entry: IndexRegistryEntry, target: AnalysisTarget): void {
  if (entry.synonyms === null) return
  prepareConfiguredSynonyms({ ...target.config, synonyms: rulesOfStoredSynonyms(entry.synonyms) }, target.language)
}
