import { MAX_GROUP_LENGTH, MAX_PERSON_UTF16_UNITS, RAW_PHRASE_UTF16_UNITS_PER_CODE_POINT } from './constants'

export interface PhraseLimits {
  minLetters: number
  maxLength: number
  maxWords: number
  maxDigits: number
}

const APOSTROPHE_VARIANTS = /[\u2018\u2019\u02bc]/g
const HYPHEN_VARIANTS = /[\u2010\u2011]/g
const WHITE_SPACE_RUNS = /\p{White_Space}+/gu
const EDGE_SPACES = /^ | $/g
const ALLOWED_PHRASE = /^[\p{L}\p{M}\p{Nd} '-]+$/u
const LETTER = /\p{L}/gu
const DIGIT = /\p{Nd}/gu
const GROUP_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${MAX_GROUP_LENGTH - 1}}$`)

export const GROUP_FORMAT = `1 to ${MAX_GROUP_LENGTH} letters, digits, "_", and "-"`

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(text) !== null) count++
  return count
}

function codePointCount(text: string, stopAfter: number): number {
  let count = 0
  for (const _ of text) {
    count++
    if (count > stopAfter) break
  }
  return count
}

export function normalisePhrase(raw: string, maxLength: number): string | null {
  if (raw.length === 0 || raw.length > maxLength * RAW_PHRASE_UTF16_UNITS_PER_CODE_POINT) return null
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHE_VARIANTS, "'")
    .replace(HYPHEN_VARIANTS, '-')
    .replace(WHITE_SPACE_RUNS, ' ')
    .replace(EDGE_SPACES, '')
}

export function phraseFits(phrase: string, limits: PhraseLimits): boolean {
  if (phrase.length === 0 || phrase.length > limits.maxLength * 2) return false
  if (phrase.startsWith(' ') || phrase.endsWith(' ') || phrase.includes('  ')) return false
  if (!ALLOWED_PHRASE.test(phrase)) return false
  if (codePointCount(phrase, limits.maxLength) > limits.maxLength) return false
  if (phrase.split(' ').length > limits.maxWords) return false
  if (countMatches(phrase, DIGIT) > limits.maxDigits) return false
  return countMatches(phrase, LETTER) >= limits.minLetters
}

export function isNormalPhrase(phrase: string, limits: PhraseLimits): boolean {
  return phraseFits(phrase, limits) && normalisePhrase(phrase, limits.maxLength) === phrase
}

export function acceptedPhrase(raw: string, limits: PhraseLimits): string | null {
  const phrase = normalisePhrase(raw, limits.maxLength)
  if (phrase === null || !phraseFits(phrase, limits)) return null
  return phrase
}

export function isGroup(value: unknown): value is string {
  return typeof value === 'string' && GROUP_PATTERN.test(value)
}

export function isPerson(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PERSON_UTF16_UNITS
}
