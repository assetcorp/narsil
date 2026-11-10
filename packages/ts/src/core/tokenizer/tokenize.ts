import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import type { CustomTokenizer } from '../../types/schema'
import { withUnpairedSurrogatesReplaced } from '../ordering/code-points'
import { transformToken } from './cache'
import { DEFAULT_MIN_TOKEN_LENGTH, DEFAULT_SPLIT_PATTERN, MAX_TOKEN_POSITION } from './constants'
import { nativeAnalysis } from './native-hook'
import { expandNgrams } from './ngrams'
import { normalizeForSplitting } from './normalize'

export interface TokenizerResult {
  tokens: Array<{ token: string; position: number }>
  originalTokens: string[]
  surfaces?: Array<string | undefined>
}

export type TokenizedTextSource = 'document' | 'query'

export interface TokenizeOptions {
  stem?: boolean
  removeStopWords?: boolean
  removeDiacritics?: boolean
  collectSurfaces?: boolean
  customTokenizer?: CustomTokenizer
  stopWordOverride?: Set<string> | ((defaults: Set<string>) => Set<string>)
  textSource?: TokenizedTextSource
}

export function producesSurfaceForms(language: LanguageModule, options?: TokenizeOptions): boolean {
  if (!options?.collectSurfaces || options.customTokenizer) return false
  return (options.stem ?? true) && language.stemmer !== null
}

export function resolveStopWords(
  language: LanguageModule,
  override?: Set<string> | ((defaults: Set<string>) => Set<string>),
): Set<string> {
  if (!override) return language.stopWords
  if (override instanceof Set) return override
  return override(language.stopWords)
}

function splitText(text: string, language: LanguageModule): string[] {
  const pattern = language.tokenizer?.splitPattern ?? DEFAULT_SPLIT_PATTERN
  const parts = text.split(pattern)
  const ngramSize = language.tokenizer?.ngramSize
  if (ngramSize === undefined || ngramSize < 1) return parts

  const size = Math.floor(ngramSize)
  const expanded: string[] = []
  for (const part of parts) {
    expandNgrams(part, size, expanded)
  }
  return expanded
}

const CHAR_APOSTROPHE = 0x27
const CHAR_S = 0x73

function stripPossessive(token: string): string {
  const len = token.length
  if (len >= 2 && token.charCodeAt(len - 1) === CHAR_S && token.charCodeAt(len - 2) === CHAR_APOSTROPHE) {
    return token.slice(0, -2)
  }
  if (len >= 1 && token.charCodeAt(len - 1) === CHAR_APOSTROPHE) {
    return token.slice(0, -1)
  }
  return token
}

function refuseTokenizerResult(source: TokenizedTextSource, message: string, details: Record<string, unknown>): never {
  const code = source === 'document' ? ErrorCodes.DOC_VALIDATION_FAILED : ErrorCodes.CONFIG_INVALID
  throw new NarsilError(code, `The custom tokenizer ${message}`, details)
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

function checkedTokenizerEntry(
  entry: unknown,
  at: number,
  source: TokenizedTextSource,
): { token: string; position: number } {
  const { token, position } = (entry !== null && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
  if (typeof token !== 'string') {
    refuseTokenizerResult(
      source,
      `returned a token of type ${kindOf(token)} at entry ${at}, where a token is a string`,
      {
        entry: at,
        tokenType: kindOf(token),
      },
    )
  }
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > MAX_TOKEN_POSITION) {
    const shown = typeof position === 'number' ? String(position) : kindOf(position)
    refuseTokenizerResult(
      source,
      `returned the position ${shown} at entry ${at}, where a position is a whole number from 0 to ${MAX_TOKEN_POSITION}`,
      { entry: at, position: shown },
    )
  }
  return { token: withUnpairedSurrogatesReplaced(token), position }
}

export function customTokensOf(
  tokenizer: CustomTokenizer,
  text: string,
  source: TokenizedTextSource = 'query',
): Array<{ token: string; position: number }> {
  const entries: unknown = tokenizer.tokenize(text)
  if (!Array.isArray(entries)) {
    refuseTokenizerResult(source, `returned ${kindOf(entries)}, where it returns a list of tokens`, {
      received: kindOf(entries),
    })
  }
  const checked = new Array<{ token: string; position: number }>(entries.length)
  for (let at = 0; at < checked.length; at++) checked[at] = checkedTokenizerEntry(entries[at], at, source)
  return checked
}

export type TokenVisitor = (token: string, position: number, surface: string | undefined, original: string) => void

export function visitTokens(
  text: string,
  language: LanguageModule,
  options: TokenizeOptions | undefined,
  visit: TokenVisitor,
): void {
  const {
    stem = true,
    removeStopWords = true,
    removeDiacritics = false,
    collectSurfaces = false,
    customTokenizer,
    stopWordOverride,
  } = options ?? {}

  if (customTokenizer) {
    for (const entry of customTokensOf(customTokenizer, text, options?.textSource)) {
      visit(entry.token, entry.position, undefined, entry.token)
    }
    return
  }
  if (nativeAnalysis()?.visitTokens(text, language, options, visit) === true) return

  const rawParts = splitText(normalizeForSplitting(text), language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH
  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const wantSurfaces = collectSurfaces && stem && language.stemmer !== null
  const stopWords = removeStopWords ? resolveStopWords(language, stopWordOverride) : null
  const stripPossessives = language.tokenizer?.stripPossessive ?? false

  for (let position = 0; position < rawParts.length; position++) {
    const part = rawParts[position]
    const candidate = stripPossessives ? stripPossessive(part) : part
    if (candidate.length < minLength || stopWords?.has(candidate)) continue
    const processed = transformToken(candidate, language, stem, effectiveDiacritics)
    if (processed.length === 0) continue
    if (!wantSurfaces) {
      visit(processed, position, undefined, part)
      continue
    }
    const shown = effectiveDiacritics ? transformToken(candidate, language, false, true) : candidate
    visit(processed, position, surfaceOf(shown, processed), part)
  }
}

function surfaceOf(shown: string, term: string): string | undefined {
  if (shown === term) return undefined
  const surface = withUnpairedSurrogatesReplaced(shown)
  return surface === term ? undefined : surface
}

export function visitSurfaceSpellings(text: string, language: LanguageModule, visit: (spelling: string) => void): void {
  if (nativeAnalysis()?.visitSpellings(text, language, visit) === true) return
  const rawParts = splitText(normalizeForSplitting(text), language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH
  const removeDiacritics = language.tokenizer?.normalizeDiacritics ?? false
  const stripPossessives = language.tokenizer?.stripPossessive ?? false
  for (const part of rawParts) {
    const candidate = stripPossessives ? stripPossessive(part) : part
    if (candidate.length < minLength) continue
    visit(
      removeDiacritics ? transformToken(candidate, language, false, true) : withUnpairedSurrogatesReplaced(candidate),
    )
  }
}

export function tokenize(text: string, language: LanguageModule, options?: TokenizeOptions): TokenizerResult {
  if (options?.customTokenizer) {
    const customResult = customTokensOf(options.customTokenizer, text, options.textSource)
    return { tokens: customResult, originalTokens: customResult.map(entry => entry.token) }
  }

  const tokens: Array<{ token: string; position: number }> = []
  const originalTokens: string[] = []
  const surfaces: Array<string | undefined> | undefined = producesSurfaceForms(language, options) ? [] : undefined
  visitTokens(text, language, options, (token, position, surface, original) => {
    tokens.push({ token, position })
    originalTokens.push(original)
    surfaces?.push(surface)
  })
  return { tokens, originalTokens, surfaces }
}

export function* tokenizeIterator(
  text: string,
  language: LanguageModule,
  options?: TokenizeOptions,
): Generator<{ token: string; position: number; surface?: string }> {
  const {
    stem = true,
    removeStopWords = true,
    removeDiacritics = false,
    collectSurfaces = false,
    customTokenizer,
    stopWordOverride,
  } = options ?? {}

  if (customTokenizer) {
    const customResult = customTokensOf(customTokenizer, text, options?.textSource)
    for (const entry of customResult) {
      yield entry
    }
    return
  }

  const normalized = normalizeForSplitting(text)
  const rawParts = splitText(normalized, language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH

  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const stemsTokens = stem && language.stemmer !== null
  const wantSurfaces = collectSurfaces && stemsTokens
  const stopWords = removeStopWords ? resolveStopWords(language, stopWordOverride) : new Set<string>()
  const stripPossessives = language.tokenizer?.stripPossessive ?? false

  let position = 0

  for (const part of rawParts) {
    const candidate = stripPossessives ? stripPossessive(part) : part

    if (candidate.length < minLength) {
      position++
      continue
    }

    if (stopWords.has(candidate)) {
      position++
      continue
    }

    const processed = transformToken(candidate, language, stem, effectiveDiacritics)

    if (processed.length > 0) {
      if (wantSurfaces) {
        const shown = effectiveDiacritics ? transformToken(candidate, language, false, true) : candidate
        yield { token: processed, position, surface: surfaceOf(shown, processed) }
      } else {
        yield { token: processed, position }
      }
    }

    position++
  }
}
