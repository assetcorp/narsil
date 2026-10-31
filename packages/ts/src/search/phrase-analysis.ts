import { ErrorCodes, NarsilError } from '../errors'
import type { AnalysedPhrase } from '../types/internal'
import type { QueryParams } from '../types/search'
import { MAX_PHRASE_WORDS, MAX_QUERY_PHRASES } from './constants'

export type AnalyseText = (text: string) => ReadonlyArray<{ token: string; position: number }>

export interface QueryPhrases {
  words: string
  phrases: AnalysedPhrase[]
  keptPhraseCount: number
  largestPhraseSize: number
  largestTokenCount: number
  endsWithPhrase: boolean
}

function phraseKeyOf(tokens: readonly string[], offsets: readonly number[]): string {
  const slots: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const gap = index === 0 ? 0 : offsets[index] - offsets[index - 1] - 1
    for (let missing = 0; missing < gap; missing++) slots.push('?')
    slots.push(tokens[index])
  }
  return `"${slots.join(' ')}"`
}

function identityOf(tokens: readonly string[], offsets: readonly number[]): string {
  return JSON.stringify([tokens, offsets])
}

export function analyseQueryPhrases(parts: readonly string[], analyseText: AnalyseText): QueryPhrases {
  const wordParts: string[] = []
  const phrases: AnalysedPhrase[] = []
  const seen = new Set<string>()
  let keptPhraseCount = 0
  let largestPhraseSize = 0
  let largestTokenCount = 0
  let wordsAfterLastPhrase = ''

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (index % 2 === 0) {
      wordParts.push(part)
      wordsAfterLastPhrase = `${wordsAfterLastPhrase} ${part}`
      continue
    }
    if (part.trim().length === 0) continue
    const entries = analyseText(part)
    if (entries.length === 0) continue

    const ordered = [...entries].sort((first, second) => first.position - second.position)
    const firstPosition = ordered[0].position
    const size = ordered[ordered.length - 1].position - firstPosition + 1
    keptPhraseCount++
    wordsAfterLastPhrase = ''
    if (size > largestPhraseSize) largestPhraseSize = size
    if (ordered.length > largestTokenCount) largestTokenCount = ordered.length

    const tokens = ordered.map(entry => entry.token)
    const offsets = ordered.map(entry => entry.position - firstPosition)
    const identity = identityOf(tokens, offsets)
    if (seen.has(identity)) continue
    seen.add(identity)
    phrases.push({ key: phraseKeyOf(tokens, offsets), tokens, offsets })
  }

  const endsWithPhrase =
    keptPhraseCount > 0 && (wordsAfterLastPhrase.trim().length === 0 || analyseText(wordsAfterLastPhrase).length === 0)

  return {
    words: wordParts.join(' '),
    phrases,
    keptPhraseCount,
    largestPhraseSize,
    largestTokenCount,
    endsWithPhrase,
  }
}

export function withWordsOnly(params: QueryParams, phrases: QueryPhrases): QueryParams {
  return { ...params, term: phrases.words, prefix: phrases.endsWithPhrase ? false : params.prefix }
}

export function refusePhraseUntilRebuilt(indexName: string, rebuildMode: 'auto' | 'manual'): never {
  const remedy =
    rebuildMode === 'manual'
      ? 'This engine leaves the rebuild to its caller, so somebody has to start it with rebuildAnalysis'
      : 'Try the query again once the rebuild finishes'
  throw new NarsilError(
    ErrorCodes.SEARCH_PHRASE_NOT_READY,
    `Index "${indexName}" holds array fields whose terms need a rebuild, so it cannot match a phrase yet. ${remedy}`,
    { indexName, rebuild: rebuildMode },
  )
}

export function requirePhrasesWithinLimits(phrases: QueryPhrases, trackPositions: boolean): void {
  if (phrases.keptPhraseCount === 0) return
  if (phrases.keptPhraseCount > MAX_QUERY_PHRASES) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_PHRASE,
      `A query takes at most ${MAX_QUERY_PHRASES} phrases, while this query holds ${phrases.keptPhraseCount}`,
      { limit: MAX_QUERY_PHRASES, phrases: phrases.keptPhraseCount },
    )
  }
  if (phrases.largestPhraseSize > MAX_PHRASE_WORDS || phrases.largestTokenCount > MAX_PHRASE_WORDS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_PHRASE,
      `A phrase takes at most ${MAX_PHRASE_WORDS} words, counting the stop words between its first and last word, while this query holds one of ${Math.max(phrases.largestPhraseSize, phrases.largestTokenCount)}`,
      { limit: MAX_PHRASE_WORDS, words: Math.max(phrases.largestPhraseSize, phrases.largestTokenCount) },
    )
  }
  if (!trackPositions) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_PHRASE,
      'This index stores no word positions because its trackPositions setting is off, so it cannot match a phrase. Remove the quotes, or create the index with trackPositions on',
      { trackPositions: false },
    )
  }
}
