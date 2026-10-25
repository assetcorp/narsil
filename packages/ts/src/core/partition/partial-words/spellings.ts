import type { LanguageModule } from '../../../types/language'
import type { AnyDocument } from '../../../types/schema'
import { visitTokens } from '../../tokenizer/tokenize'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from '../utils'

export interface PartialWordAnalysis {
  readonly fields: readonly string[]
  readonly language: LanguageModule
  readonly options: PartitionInsertOptions | undefined
}

export type SpellingCounts = Map<string, Map<string, number>>

export interface PartialSpellings {
  fields: string[]
  tokens: string[]
  spellings: string[]
  counts: number[]
}

export function countSpelling(counts: SpellingCounts, token: string, spelling: string, change: number): void {
  let byToken = counts.get(token)
  if (byToken === undefined) {
    if (change <= 0) return
    byToken = new Map()
    counts.set(token, byToken)
  }
  const next = (byToken.get(spelling) ?? 0) + change
  if (next > 0) {
    byToken.set(spelling, next)
    return
  }
  byToken.delete(spelling)
  if (byToken.size === 0) counts.delete(token)
}

function textsOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((element): element is string => typeof element === 'string')
}

export function countDocumentSpellings(
  counts: SpellingCounts,
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  direction: 1 | -1,
): void {
  const tokenizing = { ...tokenizeOptions(analysis.options), collectSurfaces: true }
  const countOccurrence = (token: string, _position: number, surface: string | undefined): void => {
    countSpelling(counts, token, surface ?? token, direction)
  }
  for (const field of analysis.fields) {
    for (const text of textsOf(getNestedValue(document as Record<string, unknown>, field))) {
      visitTokens(text, analysis.language, tokenizing, countOccurrence)
    }
  }
}

export function spellingCountsOf(documents: Iterable<AnyDocument>, analysis: PartialWordAnalysis): SpellingCounts {
  const counts: SpellingCounts = new Map()
  for (const document of documents) countDocumentSpellings(counts, document, analysis, 1)
  return counts
}

export function encodePartialSpellings(fields: readonly string[], counts: SpellingCounts): PartialSpellings {
  const encoded: PartialSpellings = { fields: [...fields], tokens: [], spellings: [], counts: [] }
  for (const [token, byToken] of counts) {
    for (const [spelling, count] of byToken) {
      encoded.tokens.push(token)
      encoded.spellings.push(spelling)
      encoded.counts.push(count)
    }
  }
  return encoded
}

export function sameFields(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let at = 0; at < left.length; at++) {
    if (left[at] !== right[at]) return false
  }
  return true
}
