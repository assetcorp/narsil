import { resolveIndexAnalysis } from '../../analysis/registry'
import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { buildSynonymLookup } from './lookup'
import { decodeSynonymRules, encodeSynonymRules, parseSynonymRules } from './rules'
import type { PreparedSynonyms, RaiseSynonymProblem, SynonymAnalysis, SynonymLookup } from './types'

function invalidIn(source: string): RaiseSynonymProblem {
  return (message, details) => {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${source}${message}`, details)
  }
}

export const raiseConfigInvalid = invalidIn('')

export function synonymAnalysisOf(config: IndexConfig, language: LanguageModule): SynonymAnalysis {
  return { language, ...resolveIndexAnalysis(config) }
}

export function prepareSynonyms(
  value: unknown,
  config: IndexConfig,
  language: LanguageModule,
  strictWords: boolean,
  raise: RaiseSynonymProblem | string = raiseConfigInvalid,
): PreparedSynonyms | null {
  const report = typeof raise === 'string' ? invalidIn(raise) : raise
  const rules = parseSynonymRules(value, report)
  if (rules.length === 0) return null
  const lookup = buildSynonymLookup(rules, synonymAnalysisOf(config, language), strictWords ? report : null)
  return { encoded: encodeSynonymRules(rules), lookup }
}

export function storedSynonymLookup(
  encoded: Uint8Array,
  config: IndexConfig,
  language: LanguageModule,
): SynonymLookup | null {
  return buildSynonymLookup(decodeSynonymRules(encoded, raiseConfigInvalid), synonymAnalysisOf(config, language), null)
}

export function storedSynonymRules(encoded: Uint8Array): SynonymRule[] {
  return decodeSynonymRules(encoded, raiseConfigInvalid)
}
