import { decode, encode } from '@msgpack/msgpack'
import type { SynonymRule } from '../../types/synonyms'
import {
  MAX_SYNONYM_RULE_WORDS,
  MAX_SYNONYM_RULES,
  MAX_SYNONYM_WORD_BYTES,
  MAX_SYNONYM_WORDS,
  MIN_ONE_WAY_SYNONYMS,
  MIN_TWO_WAY_SYNONYM_WORDS,
} from './constants'

export type RaiseSynonymProblem = (message: string, details: Record<string, unknown>) => never

const FIRST_PRINTABLE_CODE = 0x20

function holdsControlCharacter(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (word.charCodeAt(i) < FIRST_PRINTABLE_CODE) return true
  return false
}

function utf8Length(word: string): number {
  let bytes = 0
  for (let i = 0; i < word.length; i++) {
    const unit = word.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < word.length) {
      const low = word.charCodeAt(i + 1)
      if (low >= 0xdc00 && low < 0xe000) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

interface Tally {
  words: number
  bytes: number
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function readWord(value: unknown, rule: number, tally: Tally, raise: RaiseSynonymProblem): string {
  if (typeof value !== 'string') {
    raise(`Synonym rule ${rule} holds a word that is not a string`, { rule })
  }
  if (holdsControlCharacter(value)) {
    raise(`Synonym rule ${rule} holds a word with a control character`, { rule })
  }
  tally.words++
  tally.bytes += utf8Length(value)
  if (tally.words > MAX_SYNONYM_WORDS) {
    raise(`A synonym set holds at most ${MAX_SYNONYM_WORDS} words`, { maxWords: MAX_SYNONYM_WORDS })
  }
  if (tally.bytes > MAX_SYNONYM_WORD_BYTES) {
    raise(`The words of a synonym set hold at most ${MAX_SYNONYM_WORD_BYTES} bytes in UTF-8`, {
      maxWordBytes: MAX_SYNONYM_WORD_BYTES,
    })
  }
  return value
}

function readWords(
  value: unknown,
  rule: number,
  key: string,
  minimum: number,
  maximum: number,
  tally: Tally,
  raise: RaiseSynonymProblem,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    raise(`Synonym rule ${rule} needs "${key}" as a list of ${minimum} to ${maximum} words`, { rule })
  }
  const words: string[] = new Array(value.length)
  for (let i = 0; i < value.length; i++) words[i] = readWord(value[i], rule, tally, raise)
  return words
}

function readRule(value: unknown, rule: number, tally: Tally, raise: RaiseSynonymProblem): SynonymRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    raise(`Synonym rule ${rule} must be an object`, { rule })
  }
  if (hasOnlyKeys(value, ['words'])) {
    const words = Reflect.get(value, 'words')
    return { words: readWords(words, rule, 'words', MIN_TWO_WAY_SYNONYM_WORDS, MAX_SYNONYM_RULE_WORDS, tally, raise) }
  }
  if (hasOnlyKeys(value, ['word', 'synonyms'])) {
    const word = readWord(Reflect.get(value, 'word'), rule, tally, raise)
    const synonyms = readWords(
      Reflect.get(value, 'synonyms'),
      rule,
      'synonyms',
      MIN_ONE_WAY_SYNONYMS,
      MAX_SYNONYM_RULE_WORDS - 1,
      tally,
      raise,
    )
    return { word, synonyms }
  }
  raise(`Synonym rule ${rule} must hold either "words" alone, or "word" and "synonyms"`, { rule })
}

export function parseSynonymRules(value: unknown, raise: RaiseSynonymProblem): SynonymRule[] {
  if (!Array.isArray(value)) raise('A synonym set must be a list of rules', {})
  if (value.length > MAX_SYNONYM_RULES) {
    raise(`A synonym set holds at most ${MAX_SYNONYM_RULES} rules`, { maxRules: MAX_SYNONYM_RULES })
  }
  const tally: Tally = { words: 0, bytes: 0 }
  const rules: SynonymRule[] = new Array(value.length)
  for (let rule = 0; rule < value.length; rule++) rules[rule] = readRule(value[rule], rule, tally, raise)
  return rules
}

export function encodeSynonymRules(rules: readonly SynonymRule[]): Uint8Array {
  return encode(rules)
}

export function decodeSynonymRules(bytes: Uint8Array, raise: RaiseSynonymProblem): SynonymRule[] {
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    raise('A stored synonym set is not valid MessagePack', {})
  }
  return parseSynonymRules(decoded, raise)
}
