import { encode } from '#platform/suggestion-store-host'
import { MAX_BAN_LIST_BYTES, MAX_BANNED_PHRASE_CODE_POINTS, MAX_BANNED_PHRASES } from './constants'
import { acceptedPhrase, isNormalPhrase, type PhraseLimits } from './phrase'
import { invalidSetting } from './setting'

const BAN_LIMITS: PhraseLimits = {
  minLetters: 0,
  maxLength: MAX_BANNED_PHRASE_CODE_POINTS,
  maxWords: MAX_BANNED_PHRASE_CODE_POINTS,
  maxDigits: MAX_BANNED_PHRASE_CODE_POINTS,
}

function requireWithinLimits(phrases: readonly string[]): void {
  if (phrases.length > MAX_BANNED_PHRASES) {
    invalidSetting(`A ban list holds at most ${MAX_BANNED_PHRASES} phrases`, { phrases: phrases.length })
  }
  if (encode(phrases).byteLength > MAX_BAN_LIST_BYTES) {
    invalidSetting(`A ban list must encode to at most ${MAX_BAN_LIST_BYTES} bytes`)
  }
}

export function normaliseBan(raw: unknown): string {
  if (typeof raw !== 'string') invalidSetting('Each banned phrase must be a string')
  const phrase = acceptedPhrase(raw, BAN_LIMITS)
  if (phrase === null) {
    invalidSetting(
      `A banned phrase must hold up to ${MAX_BANNED_PHRASE_CODE_POINTS} letters, digits, spaces, hyphens, and apostrophes`,
    )
  }
  return phrase
}

export function banListFromInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) invalidSetting('A ban list must be an array of phrases')
  if (raw.length > MAX_BANNED_PHRASES) {
    invalidSetting(`A ban list holds at most ${MAX_BANNED_PHRASES} phrases`, { phrases: raw.length })
  }
  const phrases = [...new Set(raw.map(normaliseBan))]
  requireWithinLimits(phrases)
  return phrases
}

export function storedBanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) invalidSetting('The stored ban list is not an array')
  const seen = new Set<string>()
  for (const phrase of raw) {
    if (typeof phrase !== 'string' || !isNormalPhrase(phrase, BAN_LIMITS) || seen.has(phrase)) {
      invalidSetting('The stored ban list holds a phrase that is not in normal form, or one twice')
    }
    seen.add(phrase)
  }
  const phrases = [...seen]
  requireWithinLimits(phrases)
  return phrases
}

export function unionOfBans(first: readonly string[], second: readonly string[]): string[] {
  const union = [...new Set([...first, ...second])]
  requireWithinLimits(union)
  return union
}
