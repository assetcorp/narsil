import type { ResolvedAnalysis } from '../analysis/registry'
import type { PartitionInsertOptions } from '../core/partition'
import type { IndexConfig } from '../types/schema'

export function resolvePartitionInsertOptions(
  config: IndexConfig,
  analysis: ResolvedAnalysis,
  options?: PartitionInsertOptions,
): PartitionInsertOptions | undefined {
  const applyStrict = config.strict === true
  const applyAnalyzer = analysis.stopWords !== undefined || analysis.customTokenizer !== undefined
  const applySurfaces = config.surfaceForms !== false
  if (!applyStrict && !applyAnalyzer && !applySurfaces) return options

  const resolved: PartitionInsertOptions = { ...options }
  if (applyStrict) resolved.strict = true
  if (applyAnalyzer) {
    resolved.stopWordOverride = options?.stopWordOverride ?? analysis.stopWords
    resolved.customTokenizer = options?.customTokenizer ?? analysis.customTokenizer
  }
  if (applySurfaces) resolved.collectSurfaces = true
  return resolved
}
