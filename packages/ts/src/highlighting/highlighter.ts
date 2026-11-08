import { nativeHighlight } from '#platform/highlight'
import { fuzzyTermMatches } from '../core/fuzzy'
import { partialWordHighlighter } from '../core/partition/partial-words/registry'
import { tokenize } from '../core/tokenizer'
import type { LanguageModule } from '../types/language'
import type { HighlightMatch } from '../types/results'
import type { CustomTokenizer, StopWordOverride } from '../types/schema'
import { DEFAULT_MAX_SNIPPET_LENGTH } from './constants'
import { type CharRange, originalTokenOffsets } from './offsets'
import { renderHighlight } from './render'

export interface PartialWordHighlight {
  words: readonly string[]
  customTokenizer?: CustomTokenizer
  stopWordOverride?: StopWordOverride
}

export interface HighlightOptions {
  preTag?: string
  postTag?: string
  maxSnippetLength?: number
  prefixToken?: string
  completedToken?: string
  tolerance?: number
  prefixLength?: number
  partialWords?: PartialWordHighlight
  synonyms?: readonly string[]
}

export function highlightField(
  text: string,
  queryTokens: Array<{ token: string; position: number }>,
  language: LanguageModule,
  options?: HighlightOptions,
): HighlightMatch {
  const preTag = options?.preTag ?? '<mark>'
  const postTag = options?.postTag ?? '</mark>'
  const maxSnippetLength = options?.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH
  const stemmedQueryTokens = queryTokens.map(query => query.token)
  const matchedRanges: CharRange[] = []
  const prefixToken = options?.prefixToken
  const tolerance = options?.tolerance ?? 0
  const prefixLength = options?.prefixLength ?? 0
  const completedToken = options?.completedToken
  const queryTolerances = queryTokens.map(query => (query.token === completedToken ? 0 : tolerance))
  const native = nativeHighlight(
    text,
    stemmedQueryTokens.map((token, index) => ({ token, tolerance: queryTolerances[index] })),
    language,
    options,
  )
  if (native !== null) return native
  const fieldResult = tokenize(text, language, { stem: false, removeStopWords: false })
  const charOffsets = originalTokenOffsets(text, language)
  const synonyms = options?.synonyms
  const matchByFieldToken = new Map<string, boolean>()
  const matchesQuery = (fieldToken: string): boolean => {
    const known = matchByFieldToken.get(fieldToken)
    if (known !== undefined) return known
    const stemmedField = language.stemmer ? language.stemmer(fieldToken) : fieldToken
    const matches =
      synonyms?.includes(stemmedField) === true ||
      stemmedQueryTokens.some((query, index) =>
        fuzzyTermMatches(query, stemmedField, queryTolerances[index], prefixLength),
      )
    matchByFieldToken.set(fieldToken, matches)
    return matches
  }
  const matchesInside =
    options?.partialWords === undefined ? null : partialWordHighlighter(text, language, options.partialWords)
  for (const token of fieldResult.tokens) {
    const range = charOffsets[token.position]
    if (range === undefined || range.start >= range.end) continue
    if (
      (prefixToken !== undefined && token.token.startsWith(prefixToken)) ||
      matchesInside?.(token.position, token.token) === true ||
      matchesQuery(token.token)
    )
      matchedRanges.push(range)
  }
  return renderHighlight(text, matchedRanges, preTag, postTag, maxSnippetLength)
}
