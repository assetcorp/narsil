import type { LanguageModule } from '../../types/language'
import type { CustomTokenizer } from '../../types/schema'
import { transformToken } from './cache'
import { expandNgrams } from './ngrams'
import { normalizeForSplitting } from './normalize'

export interface TokenizerResult {
  tokens: Array<{ token: string; position: number }>
  originalTokens: string[]
  surfaces?: Array<string | undefined>
}

export interface TokenizeOptions {
  stem?: boolean
  removeStopWords?: boolean
  removeDiacritics?: boolean
  collectSurfaces?: boolean
  customTokenizer?: CustomTokenizer
  stopWordOverride?: Set<string> | ((defaults: Set<string>) => Set<string>)
}

export function producesSurfaceForms(language: LanguageModule, options?: TokenizeOptions): boolean {
  if (!options?.collectSurfaces || options.customTokenizer) return false
  return (options.stem ?? true) && language.stemmer !== undefined
}

const DEFAULT_SPLIT_PATTERN = /[^\p{L}\p{M}\p{N}_'-]+/u
const DEFAULT_MIN_TOKEN_LENGTH = 1

function resolveStopWords(
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

export function tokenize(text: string, language: LanguageModule, options?: TokenizeOptions): TokenizerResult {
  const {
    stem = true,
    removeStopWords = true,
    removeDiacritics = false,
    collectSurfaces = false,
    customTokenizer,
    stopWordOverride,
  } = options ?? {}

  if (customTokenizer) {
    const customResult = customTokenizer.tokenize(text)
    const originals = customResult.map(t => t.token)
    return {
      tokens: customResult,
      originalTokens: originals,
    }
  }

  const normalized = normalizeForSplitting(text)
  const rawParts = splitText(normalized, language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH

  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const stemsTokens = stem && language.stemmer !== undefined
  const stopWords = removeStopWords ? resolveStopWords(language, stopWordOverride) : new Set<string>()
  const stripPossessives = language.tokenizer?.stripPossessive ?? false

  const tokens: Array<{ token: string; position: number }> = []
  const originalTokens: string[] = []
  const surfaces: Array<string | undefined> | undefined = collectSurfaces && stemsTokens ? [] : undefined
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
      tokens.push({ token: processed, position })
      originalTokens.push(part)
      if (surfaces) {
        const surface = effectiveDiacritics ? transformToken(candidate, language, false, true) : candidate
        surfaces.push(surface === processed ? undefined : surface)
      }
    }

    position++
  }

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
    const customResult = customTokenizer.tokenize(text)
    for (const entry of customResult) {
      yield entry
    }
    return
  }

  const normalized = normalizeForSplitting(text)
  const rawParts = splitText(normalized, language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH

  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const stemsTokens = stem && language.stemmer !== undefined
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
        const surface = effectiveDiacritics ? transformToken(candidate, language, false, true) : candidate
        yield { token: processed, position, surface: surface === processed ? undefined : surface }
      } else {
        yield { token: processed, position }
      }
    }

    position++
  }
}
