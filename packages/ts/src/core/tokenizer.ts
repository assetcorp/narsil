import { createNarsilError, ErrorCodes } from '../errors'
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

const CACHE_SIZE_FLOOR = 50_000
const CACHE_SIZE_CEILING = 2_000_000
const BYTES_PER_ENTRY = 200

function computeDefaultCacheSize(): number {
  try {
    if (typeof process !== 'undefined' && typeof process.versions?.node === 'string' && typeof window === 'undefined') {
      const constrainedMemory = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
      if (constrainedMemory > 0) {
        const budget = Math.floor((constrainedMemory * 0.05) / BYTES_PER_ENTRY)
        return Math.max(CACHE_SIZE_FLOOR, Math.min(budget, CACHE_SIZE_CEILING))
      }
      return Math.max(CACHE_SIZE_FLOOR, Math.min(1_000_000, CACHE_SIZE_CEILING))
    }

    if (typeof navigator !== 'undefined') {
      const mem = (navigator as { deviceMemory?: number }).deviceMemory
      if (typeof mem === 'number' && mem > 0) {
        let entries: number
        if (mem <= 1) entries = 100_000
        else if (mem <= 4) entries = 250_000
        else entries = 500_000
        return Math.max(CACHE_SIZE_FLOOR, Math.min(entries, CACHE_SIZE_CEILING))
      }
      return Math.max(CACHE_SIZE_FLOOR, Math.min(200_000, CACHE_SIZE_CEILING))
    }
  } catch {
    /* environment detection failed; fall through to default */
  }
  return Math.max(CACHE_SIZE_FLOOR, Math.min(200_000, CACHE_SIZE_CEILING))
}

const normalizationCache = new Map<string, string>()
let maxCacheSize = computeDefaultCacheSize()

export function configureNormalizationCache(maxSize: number): void {
  if (!Number.isFinite(maxSize)) {
    throw createNarsilError(ErrorCodes.CONFIG_INVALID, 'tokenizerCacheSize must be a finite number', {
      received: maxSize,
    })
  }
  if (maxSize < 0) {
    throw createNarsilError(ErrorCodes.CONFIG_INVALID, 'tokenizerCacheSize must not be negative', {
      received: maxSize,
    })
  }
  maxCacheSize = Math.max(CACHE_SIZE_FLOOR, Math.min(Math.floor(maxSize), CACHE_SIZE_CEILING))
}

let cachedLangName = ''
let cachedFlags = ''
let cachedPrefix = ''

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

function getCachePrefix(language: LanguageModule, flags: string): string {
  if (language.name === cachedLangName && flags === cachedFlags) return cachedPrefix
  cachedLangName = language.name
  cachedFlags = flags
  cachedPrefix = `${language.name}:${flags}:`
  return cachedPrefix
}

function transformToken(raw: string, language: LanguageModule, stem: boolean, removeDiacritics: boolean): string {
  const flags = (stem ? 's' : '') + (removeDiacritics ? 'd' : '')
  const prefix = getCachePrefix(language, flags)
  const cacheKey = prefix + raw
  const cached = normalizationCache.get(cacheKey)
  if (cached !== undefined) return cached

  let normalized = raw

  if (removeDiacritics) {
    normalized = stripDiacritics(normalized)
  }

  if (stem && language.stemmer) {
    normalized = language.stemmer(normalized)
  }

  if (normalizationCache.size >= maxCacheSize) {
    const evictCount = maxCacheSize >>> 2
    let count = 0
    for (const key of normalizationCache.keys()) {
      if (count >= evictCount) break
      normalizationCache.delete(key)
      count++
    }
  }
  normalizationCache.set(cacheKey, normalized)
  return normalized
}

function splitText(text: string, language: LanguageModule): string[] {
  const pattern = language.tokenizer?.splitPattern ?? DEFAULT_SPLIT_PATTERN
  return text.split(pattern)
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false
  }
  return true
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

  const normalized = isAscii(text) ? text.toLowerCase() : text.normalize('NFC').toLowerCase()
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

export function* tokenizeIterator(
  text: string,
  language: LanguageModule,
  options?: TokenizeOptions,
): Generator<{ token: string; position: number }> {
  const {
    stem = true,
    removeStopWords = true,
    removeDiacritics = false,
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

  const normalized = isAscii(text) ? text.toLowerCase() : text.normalize('NFC').toLowerCase()
  const rawParts = splitText(normalized, language)
  const minLength = language.tokenizer?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH

  const effectiveDiacritics = removeDiacritics || (language.tokenizer?.normalizeDiacritics ?? false)
  const stopWords = removeStopWords ? resolveStopWords(language, stopWordOverride) : new Set<string>()

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
      yield { token: processed, position }
    }

    position++
  }
}

export function clearNormalizationCache(): void {
  normalizationCache.clear()
}

export function getNormalizationCacheSize(): number {
  return normalizationCache.size
}
