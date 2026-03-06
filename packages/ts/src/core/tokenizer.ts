import type { LanguageModule } from '../types/language'
import type { CustomTokenizer } from '../types/schema'

export interface TokenizerResult {
  tokens: Array<{ token: string; position: number }>
  originalTokens: string[]
}

export interface TokenizeOptions {
  stem?: boolean
  removeStopWords?: boolean
  removeDiacritics?: boolean
  customTokenizer?: CustomTokenizer
  stopWordOverride?: Set<string> | ((defaults: Set<string>) => Set<string>)
}

const DEFAULT_SPLIT_PATTERN = /[^\p{L}\p{N}_'-]+/u
const DEFAULT_MIN_TOKEN_LENGTH = 1

const normalizationCache = new Map<string, string>()
const MAX_CACHE_SIZE = 65536

function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function resolveStopWords(
  language: LanguageModule,
  override?: Set<string> | ((defaults: Set<string>) => Set<string>),
): Set<string> {
  if (!override) return language.stopWords
  if (override instanceof Set) return override
  return override(language.stopWords)
}

function transformToken(raw: string, language: LanguageModule, stem: boolean, removeDiacritics: boolean): string {
  const flags = (stem ? 's' : '') + (removeDiacritics ? 'd' : '')
  const cacheKey = `${language.name}:${flags}:${raw}`
  const cached = normalizationCache.get(cacheKey)
  if (cached !== undefined) return cached

  let normalized = raw

  if (removeDiacritics) {
    normalized = stripDiacritics(normalized)
  }

  if (stem && language.stemmer) {
    normalized = language.stemmer(normalized)
  }

  cacheAndReturn(cacheKey, normalized)
  return normalized
}

function cacheAndReturn(key: string, value: string): void {
  if (normalizationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = normalizationCache.keys().next().value as string
    normalizationCache.delete(firstKey)
  }
  normalizationCache.set(key, value)
}

function splitText(text: string, language: LanguageModule): string[] {
  const pattern = language.tokenizer?.splitPattern ?? DEFAULT_SPLIT_PATTERN
  return text.split(pattern)
}

export function tokenize(text: string, language: LanguageModule, options?: TokenizeOptions): TokenizerResult {
  const {
    stem = true,
    removeStopWords = true,
    removeDiacritics = false,
    customTokenizer,
    stopWordOverride,
  } = options ?? {}

  if (customTokenizer) {
    const customResult = customTokenizer.tokenize(text)
    return {
      tokens: customResult,
      originalTokens: customResult.map(t => t.token),
    }
  }

  const normalized = text.normalize('NFC').toLowerCase()
  const rawParts = splitText(normalized, language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH

  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const stopWords = removeStopWords ? resolveStopWords(language, stopWordOverride) : new Set<string>()

  const tokens: Array<{ token: string; position: number }> = []
  const originalTokens: string[] = []
  let position = 0

  for (const part of rawParts) {
    if (part.length < minLength) {
      position++
      continue
    }

    if (stopWords.has(part)) {
      position++
      continue
    }

    const processed = transformToken(part, language, stem, effectiveDiacritics)

    if (processed.length > 0) {
      tokens.push({ token: processed, position })
      originalTokens.push(part)
    }

    position++
  }

  return { tokens, originalTokens }
}

export function clearNormalizationCache(): void {
  normalizationCache.clear()
}
