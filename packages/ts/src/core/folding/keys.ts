import type { LanguageModule } from '../../types/language'
import { FOLD_KEY_CACHE_MAX_ENTRIES } from './constants'

const COMBINING_MARKS = /[̀-ͯ]/g
const LAST_ASCII_UNIT = 0x7f

export interface FoldedSpelling {
  readonly fold: string
  readonly key: string
}

export interface FoldingRules {
  readonly letters: ReadonlyMap<string, string> | null
  readonly asciiLetters: boolean
  readonly stemmer: ((token: string) => string) | null
  readonly cache: Map<string, FoldedSpelling>
}

const rulesByLanguage = new WeakMap<LanguageModule, FoldingRules>()

function holdsOnlyAscii(text: string): boolean {
  for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > LAST_ASCII_UNIT) return false
  return true
}

export function foldingRulesOf(language: LanguageModule): FoldingRules {
  const held = rulesByLanguage.get(language)
  if (held !== undefined) return held
  const entries = Object.entries(language.folding?.letters ?? {})
  const rules: FoldingRules = {
    letters: entries.length === 0 ? null : new Map(entries),
    asciiLetters: entries.some(([letter]) => holdsOnlyAscii(letter)),
    stemmer: language.stemmer,
    cache: new Map(),
  }
  rulesByLanguage.set(language, rules)
  return rules
}

function replaceLetters(text: string, letters: ReadonlyMap<string, string>): string {
  let replaced = ''
  for (const point of text) replaced += letters.get(point) ?? point
  return replaced
}

export function foldText(text: string, rules: FoldingRules): string {
  if (!rules.asciiLetters && holdsOnlyAscii(text)) return text
  const stripped = text.normalize('NFD').replace(COMBINING_MARKS, '')
  return rules.letters === null ? stripped : replaceLetters(stripped, rules.letters)
}

export function foldedSpelling(spelling: string, rules: FoldingRules): FoldedSpelling {
  const held = rules.cache.get(spelling)
  if (held !== undefined) return held
  const fold = foldText(spelling, rules)
  const folded = { fold, key: rules.stemmer === null ? fold : rules.stemmer(fold) }
  if (rules.cache.size >= FOLD_KEY_CACHE_MAX_ENTRIES) rules.cache.clear()
  rules.cache.set(spelling, folded)
  return folded
}
