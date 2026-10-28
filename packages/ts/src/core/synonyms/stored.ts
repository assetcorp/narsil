import { ErrorCodes, NarsilError } from '../../errors'
import type { SynonymRule } from '../../types/synonyms'
import { buildSynonymLookup } from './registry'
import { decodeSynonymRules, encodeSynonymRules, parseSynonymRules, type RaiseSynonymProblem } from './rules'
import type { SynonymAnalysis, SynonymLookup } from './types'

export interface PreparedSynonyms {
  encoded: Uint8Array
  lookup: SynonymLookup | null
}

export const raiseConfigInvalid: RaiseSynonymProblem = (message, details) => {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, message, details)
}

export function prepareSynonyms(
  value: unknown,
  analysis: SynonymAnalysis,
  raise: RaiseSynonymProblem = raiseConfigInvalid,
  strictWords = true,
): PreparedSynonyms | null {
  const rules = parseSynonymRules(value, raise)
  if (rules.length === 0) return null
  return { encoded: encodeSynonymRules(rules), lookup: buildSynonymLookup(rules, analysis, strictWords ? raise : null) }
}

export function storedSynonymLookup(
  encoded: Uint8Array | null | undefined,
  analysis: SynonymAnalysis,
): SynonymLookup | null {
  if (encoded === null || encoded === undefined) return null
  return buildSynonymLookup(decodeSynonymRules(encoded, raiseConfigInvalid), analysis, null)
}

export function storedSynonymRules(encoded: Uint8Array | null | undefined): SynonymRule[] {
  if (encoded === null || encoded === undefined) return []
  return decodeSynonymRules(encoded, raiseConfigInvalid)
}
