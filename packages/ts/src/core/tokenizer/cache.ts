import { createNarsilError, ErrorCodes } from '../../errors'
import type { LanguageModule } from '../../types/language'
import {
  CONSTRAINED_MEMORY_TOKEN_CACHE_FRACTION,
  LARGE_DEVICE_TOKEN_CACHE_ENTRIES,
  MEDIUM_DEVICE_MEMORY_GB,
  MEDIUM_DEVICE_TOKEN_CACHE_ENTRIES,
  NODE_TOKEN_CACHE_ENTRIES,
  SMALL_DEVICE_MEMORY_GB,
  SMALL_DEVICE_TOKEN_CACHE_ENTRIES,
  TOKEN_CACHE_BYTES_PER_ENTRY,
  TOKEN_CACHE_SIZE_CEILING,
  TOKEN_CACHE_SIZE_FLOOR,
  UNKNOWN_MEMORY_TOKEN_CACHE_ENTRIES,
} from './constants'
import { stripDiacritics } from './normalize'

function clampCacheSize(entries: number): number {
  return Math.max(TOKEN_CACHE_SIZE_FLOOR, Math.min(entries, TOKEN_CACHE_SIZE_CEILING))
}

function computeDefaultCacheSize(): number {
  try {
    if (typeof process !== 'undefined' && typeof process.versions?.node === 'string' && typeof window === 'undefined') {
      const constrainedMemory = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
      if (constrainedMemory > 0) {
        const budget = constrainedMemory * CONSTRAINED_MEMORY_TOKEN_CACHE_FRACTION
        return clampCacheSize(Math.floor(budget / TOKEN_CACHE_BYTES_PER_ENTRY))
      }
      return clampCacheSize(NODE_TOKEN_CACHE_ENTRIES)
    }

    if (typeof navigator !== 'undefined') {
      const mem = (navigator as { deviceMemory?: number }).deviceMemory
      if (typeof mem === 'number' && mem > 0) {
        let entries: number
        if (mem <= SMALL_DEVICE_MEMORY_GB) entries = SMALL_DEVICE_TOKEN_CACHE_ENTRIES
        else if (mem <= MEDIUM_DEVICE_MEMORY_GB) entries = MEDIUM_DEVICE_TOKEN_CACHE_ENTRIES
        else entries = LARGE_DEVICE_TOKEN_CACHE_ENTRIES
        return clampCacheSize(entries)
      }
    }
  } catch {
    return clampCacheSize(UNKNOWN_MEMORY_TOKEN_CACHE_ENTRIES)
  }
  return clampCacheSize(UNKNOWN_MEMORY_TOKEN_CACHE_ENTRIES)
}

const normalizationCache = new Map<string, Map<string, string>>()
let normalizationCacheSize = 0
let maxCacheSize = computeDefaultCacheSize()

let cachedLangName = ''
let cachedFlags = ''
let cachedBucket: Map<string, string> | null = null

/**
 * Sets how many normalised tokens the engine keeps cached.
 *
 * Normalising a token costs the same work every time the same word arrives, so
 * the engine remembers the result. It sizes the cache from the host's memory
 * on start-up; raise it for a corpus with a large vocabulary, and lower it on
 * a memory-tight host.
 *
 * @param maxSize - Entries to keep. Zero switches the cache off.
 * @throws A `NarsilError` with `CONFIG_INVALID` for a negative or non-finite
 * size.
 *
 * @public
 */
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
  maxCacheSize = Math.max(TOKEN_CACHE_SIZE_FLOOR, Math.min(Math.floor(maxSize), TOKEN_CACHE_SIZE_CEILING))
  if (normalizationCacheSize > maxCacheSize) {
    evictOldestEntries(normalizationCacheSize - maxCacheSize)
  }
}

function getCacheBucket(language: LanguageModule, flags: string): Map<string, string> {
  const langKey = `${language.name}@${language.revision}`
  if (cachedBucket && langKey === cachedLangName && flags === cachedFlags) return cachedBucket
  const key = `${langKey}:${flags}`
  let bucket = normalizationCache.get(key)
  if (!bucket) {
    bucket = new Map()
    normalizationCache.set(key, bucket)
  }
  cachedLangName = langKey
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

/**
 * Empties the normalisation cache while keeping the size you configured.
 *
 * Call it to release the memory the cache holds after a large load, or after
 * registering a language module that normalises differently from the one whose
 * results are cached.
 *
 * @public
 */
export function clearNormalizationCache(): void {
  normalizationCache.clear()
  normalizationCacheSize = 0
  cachedBucket = null
}

/**
 * Empties the normalisation cache and returns its size to the value the engine
 * derives from the host's memory, undoing
 * {@link configureNormalizationCache}.
 *
 * @public
 */
export function resetNormalizationCache(): void {
  clearNormalizationCache()
  maxCacheSize = computeDefaultCacheSize()
}

/**
 * Returns the number of normalised tokens the cache currently holds, which is
 * what you watch to decide whether the configured size fits your vocabulary.
 *
 * @returns Entries held, across every language.
 *
 * @public
 */
export function getNormalizationCacheSize(): number {
  return normalizationCacheSize
}
