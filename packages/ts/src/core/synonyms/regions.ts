import type { NativeSynonymTable } from '../../vector/native/types/synonyms'
import { typedRegion } from '../stored-values/regions'

function validOffsets(offsets: Uint32Array, end: number): boolean {
  if (offsets.length === 0 || offsets[0] !== 0 || offsets[offsets.length - 1] !== end) return false
  for (let at = 1; at < offsets.length; at++) if (offsets[at] < offsets[at - 1]) return false
  return true
}

export function readSynonymTable(input: NativeSynonymTable): NativeSynonymTable | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = {
    tokens: input.tokens,
    offsets: input.offsets,
    ruleStart: input.ruleStart,
    ruleSource: input.ruleSource,
    ruleTokens: input.ruleTokens,
    tokenStart: input.tokenStart,
    tokenRules: input.tokenRules,
  }
  const tokens = typedRegion(raw.tokens, 'Uint8Array')
  const offsets = typedRegion(raw.offsets, 'Uint32Array')
  const ruleStart = typedRegion(raw.ruleStart, 'Uint32Array')
  const ruleSource = typedRegion(raw.ruleSource, 'Int32Array')
  const ruleTokens = typedRegion(raw.ruleTokens, 'Uint32Array')
  const tokenStart = typedRegion(raw.tokenStart, 'Uint32Array')
  const tokenRules = typedRegion(raw.tokenRules, 'Uint32Array')
  if (
    tokens === null ||
    offsets === null ||
    ruleStart === null ||
    ruleSource === null ||
    ruleTokens === null ||
    tokenStart === null ||
    tokenRules === null
  )
    return null
  const count = offsets.length - 1
  if (
    count > 0x80000000 ||
    tokens.length > 0xffffffff ||
    ruleSource.length > 0xffffffff ||
    ruleTokens.length > 0xffffffff ||
    tokenRules.length > 0xffffffff ||
    ruleStart.length !== ruleSource.length + 1 ||
    tokenStart.length !== offsets.length ||
    !validOffsets(offsets, tokens.length) ||
    !validOffsets(ruleStart, ruleTokens.length) ||
    !validOffsets(tokenStart, tokenRules.length)
  )
    return null
  for (const source of ruleSource) if (source < -1 || source >= count) return null
  for (const token of ruleTokens) if (token >= count) return null
  for (const rule of tokenRules) if (rule >= ruleSource.length) return null
  return { tokens, offsets, ruleStart, ruleSource, ruleTokens, tokenStart, tokenRules }
}

export function validQueryStarts(starts: Uint32Array, units: Uint16Array): boolean {
  return units.length <= 0xffffffff && starts.length - 1 <= 0xffffffff && validOffsets(starts, units.length)
}
