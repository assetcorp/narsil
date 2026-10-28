import type { LanguageModule } from '../../../types/language'
import type { AnyDocument } from '../../../types/schema'
import { visitSurfaceSpellings, visitTokens } from '../../tokenizer/tokenize'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from '../utils'
import { PARTIAL_WORD_RUN_CODE_POINTS } from './constants'

const LAST_BASIC_PLANE_CODE_POINT = 0xffff

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

export function codePointCountOf(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; count++) {
    index += (text.codePointAt(index) ?? 0) > LAST_BASIC_PLANE_CODE_POINT ? 2 : 1
  }
  return count
}

function holdsRun(spelling: string): boolean {
  if (spelling.length > 2 * PARTIAL_WORD_RUN_CODE_POINTS) return true
  if (spelling.length <= PARTIAL_WORD_RUN_CODE_POINTS) return false
  return codePointCountOf(spelling) > PARTIAL_WORD_RUN_CODE_POINTS
}

export function countSpelling(counts: SpellingCounts, token: string, spelling: string, change: number): void {
  if (!holdsRun(spelling)) return
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

function visitFieldTexts(document: AnyDocument, fields: readonly string[], visit: (text: string) => void): void {
  for (const field of fields) {
    for (const text of textsOf(getNestedValue(document as Record<string, unknown>, field))) visit(text)
  }
}

export function visitDocumentSpellings(
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  visit: (token: string, spelling: string) => void,
): void {
  const tokenizing = { ...tokenizeOptions(analysis.options), collectSurfaces: true }
  const visitOccurrence = (token: string, _position: number, surface: string | undefined): void => {
    visit(token, surface ?? token)
  }
  visitFieldTexts(document, analysis.fields, text => visitTokens(text, analysis.language, tokenizing, visitOccurrence))
}

export function visitDocumentSurfaceSpellings(
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  visit: (spelling: string) => void,
): void {
  if (analysis.options?.customTokenizer !== undefined) return
  visitFieldTexts(document, analysis.fields, text => visitSurfaceSpellings(text, analysis.language, visit))
}

export function countDocumentSpellings(
  counts: SpellingCounts,
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  direction: 1 | -1,
): void {
  visitDocumentSpellings(document, analysis, (token, spelling) => countSpelling(counts, token, spelling, direction))
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
