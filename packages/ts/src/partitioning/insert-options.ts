import type { ResolvedAnalysis } from '../analysis/registry'
import type { PartitionInsertOptions } from '../core/partition'
import type { PartialWordAnalysis } from '../core/partition/partial-words/spellings'
import { partialFieldsOf } from '../schema/validator'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'

export function resolvePartialWordAnalysis(
  config: IndexConfig,
  language: LanguageModule,
  analysis: ResolvedAnalysis,
): PartialWordAnalysis | null {
  const fields = partialFieldsOf(config.schema)
  if (fields.length === 0) return null
  return { fields, language, options: resolvePartitionInsertOptions(config, analysis) }
}

export function resolvePartitionInsertOptions(
  config: IndexConfig,
  analysis: ResolvedAnalysis,
  options?: PartitionInsertOptions,
): PartitionInsertOptions | undefined {
  const applyStrict = config.strict === true
  const applyAnalyzer = analysis.stopWords !== undefined || analysis.customTokenizer !== undefined
  const applySurfaces = config.surfaceForms !== false
  const applyPatternLimit = config.patternValueLimit !== undefined
  if (!applyStrict && !applyAnalyzer && !applySurfaces && !applyPatternLimit) return options

  const resolved: PartitionInsertOptions = { ...options }
  if (applyStrict) resolved.strict = true
  if (applyPatternLimit) resolved.patternValueLimit = config.patternValueLimit
  if (applyAnalyzer) {
    resolved.stopWordOverride = options?.stopWordOverride ?? analysis.stopWords
    resolved.customTokenizer = options?.customTokenizer ?? analysis.customTokenizer
  }
  if (applySurfaces) resolved.collectSurfaces = true
  return resolved
}
