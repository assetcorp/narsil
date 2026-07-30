import { createNarsilError, ErrorCodes } from '../../errors'
import type { LanguageModule } from '../../types/language'
import { stripDiacritics } from './normalize'

const CACHE_SIZE_FLOOR = 50_000
const CACHE_SIZE_CEILING = 2_000_000
const BYTES_PER_ENTRY = 200
const NODE_CACHE_ENTRIES = 1_000_000
const UNKNOWN_MEMORY_CACHE_ENTRIES = 200_000

function clampCacheSize(entries: number): number {
  return Math.max(CACHE_SIZE_FLOOR, Math.min(entries, CACHE_SIZE_CEILING))
}

function computeDefaultCacheSize(): number {
  try {
    if (typeof process !== 'undefined' && typeof process.versions?.node === 'string' && typeof window === 'undefined') {
      const constrainedMemory = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
      if (constrainedMemory > 0) {
        return clampCacheSize(Math.floor((constrainedMemory * 0.05) / BYTES_PER_ENTRY))
      }
      return clampCacheSize(NODE_CACHE_ENTRIES)
    }

    if (typeof navigator !== 'undefined') {
      const mem = (navigator as { deviceMemory?: number }).deviceMemory
      if (typeof mem === 'number' && mem > 0) {
        let entries: number
        if (mem <= 1) entries = 100_000
        else if (mem <= 4) entries = 250_000
        else entries = 500_000
        return clampCacheSize(entries)
      }
    }
  } catch {
    return clampCacheSize(UNKNOWN_MEMORY_CACHE_ENTRIES)
  }
  return clampCacheSize(UNKNOWN_MEMORY_CACHE_ENTRIES)
}

const normalizationCache = new Map<string, Map<string, string>>()
let normalizationCacheSize = 0
let maxCacheSize = computeDefaultCacheSize()

let cachedLangName = ''
let cachedFlags = ''
let cachedBucket: Map<string, string> | null = null

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
  if (maxSize === 0) {
    throw createNarsilError(
      ErrorCodes.CONFIG_INVALID,
      'tokenizerCacheSize must be greater than zero; the normalization cache cannot be disabled',
      {
        received: maxSize,
      },
    )
  }
  maxCacheSize = Math.max(CACHE_SIZE_FLOOR, Math.min(Math.floor(maxSize), CACHE_SIZE_CEILING))
  if (normalizationCacheSize > maxCacheSize) {
    evictOldestEntries(normalizationCacheSize - maxCacheSize)
  }
}

function getCacheBucket(language: LanguageModule, flags: string): Map<string, string> {
  if (cachedBucket && language.name === cachedLangName && flags === cachedFlags) return cachedBucket
  const key = `${language.name}:${flags}`
  let bucket = normalizationCache.get(key)
  if (!bucket) {
    bucket = new Map()
    normalizationCache.set(key, bucket)
  }
  cachedLangName = language.name
  cachedFlags = flags
  cachedBucket = bucket
  return bucket
}

function evictOldestEntries(count: number): void {
  let remaining = count
  for (const [key, bucket] of normalizationCache) {
    if (remaining <= 0) break
    if (bucket.size <= remaining) {
      remaining -= bucket.size
      normalizationCacheSize -= bucket.size
      normalizationCache.delete(key)
      if (bucket === cachedBucket) cachedBucket = null
    } else {
      let deleted = 0
      for (const raw of bucket.keys()) {
        if (deleted >= remaining) break
        bucket.delete(raw)
        deleted++
      }
      normalizationCacheSize -= deleted
      remaining = 0
    }
  }
}

export function transformToken(
  raw: string,
  language: LanguageModule,
  stem: boolean,
  removeDiacritics: boolean,
): string {
  const flags = (stem ? 's' : '') + (removeDiacritics ? 'd' : '')
  let bucket = getCacheBucket(language, flags)
  const cached = bucket.get(raw)
  if (cached !== undefined) return cached

  let normalized = raw

  if (language.normalizer) {
    normalized = language.normalizer(normalized)
  }

  if (removeDiacritics) {
    normalized = stripDiacritics(normalized)
  }

  if (stem && language.stemmer) {
    normalized = language.stemmer(normalized)
  }

  if (normalizationCacheSize >= maxCacheSize) {
    evictOldestEntries(Math.max(1, maxCacheSize >>> 2))
    bucket = getCacheBucket(language, flags)
  }
  bucket.set(raw, normalized)
  normalizationCacheSize++
  return normalized
}

export function clearNormalizationCache(): void {
  normalizationCache.clear()
  normalizationCacheSize = 0
  cachedBucket = null
}

export function resetNormalizationCache(): void {
  clearNormalizationCache()
  maxCacheSize = computeDefaultCacheSize()
}

export function getNormalizationCacheSize(): number {
  return normalizationCacheSize
}
