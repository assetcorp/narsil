import type { FieldFilter } from '../../../types/filters'
import type { Random } from './random-corpus'

const REGEX_RESERVED = new Set(['\\', '.', '|', '*', '+', '?', '{', '}', '(', ')', '[', ']', '^', '$', '<', '>'])
const WILDCARD_RESERVED = new Set(['\\', '*', '?'])
const PUNCTUATION = /^[!-/:-@[-`{-~]$/u
const CLASSES = ['\\d', '\\w', '\\s', '.']
const REPEATS = ['*', '+', '?', '{0,2}', '{1}', '{2,}', '{1,3}']

function below(random: Random, limit: number): number {
  return Math.floor(random() * limit)
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[below(random, items.length)]
}

function sliceOf(random: Random, value: string, maxLength: number): string[] {
  const characters = Array.from(value)
  const start = below(random, characters.length + 1)
  return characters.slice(start, start + 1 + below(random, maxLength))
}

function regexLiteral(character: string): string {
  if (!REGEX_RESERVED.has(character)) return character
  return PUNCTUATION.test(character) ? `\\${character}` : character
}

const SET_ESCAPES = new Set(['-', ']', '[', '\\', '^'])

function setOf(random: Random, character: string): string {
  const member = SET_ESCAPES.has(character) ? `\\${character}` : character
  const extra = pick(random, ['a-z', 'A-Z', '0-9', '\\d', '_', 'ß', 'é'])
  return random() < 0.2 ? `[^${extra}]` : `[${member}${extra}]`
}

function regexPiece(random: Random, character: string): string {
  const roll = random()
  let atom = regexLiteral(character)
  if (roll < 0.1) atom = pick(random, CLASSES)
  else if (roll < 0.2) atom = setOf(random, character)
  else if (roll < 0.24 && /^\d$/u.test(character)) atom = `<0-${below(random, 200)}>`
  return random() < 0.15 ? atom + pick(random, REPEATS) : atom
}

function regexBranch(random: Random, value: string): string {
  const pieces = sliceOf(random, value, 6).map(character => regexPiece(random, character))
  if (pieces.length > 2 && random() < 0.2) {
    const at = 1 + below(random, pieces.length - 2)
    pieces.splice(at, 2, `(${pieces[at]}${pieces[at + 1]})${pick(random, ['', '?', '+', '{1,2}'])}`)
  }
  const anchored = random()
  const body = pieces.join('')
  if (anchored < 0.15) return `^${body}`
  if (anchored < 0.3) return `${body}$`
  if (anchored < 0.4) return `\\b${body}`
  return body
}

export function randomRegex(random: Random, values: readonly string[]): string {
  const first = values.length === 0 ? 'abc' : pick(random, values)
  if (random() < 0.2)
    return `${regexBranch(random, first)}|${regexBranch(random, pick(random, values.length === 0 ? ['x'] : values))}`
  return regexBranch(random, first)
}

export function randomWildcard(random: Random, values: readonly string[]): string {
  const characters = Array.from(values.length === 0 ? 'abc' : pick(random, values))
  const start = below(random, characters.length + 1)
  const end = start + below(random, characters.length - start + 1)
  let pattern = random() < 0.5 && start > 0 ? '*' : ''
  for (let at = start; at < end; at++) {
    const roll = random()
    if (roll < 0.1) pattern += '?'
    else if (roll < 0.17) pattern += '*'
    else pattern += WILDCARD_RESERVED.has(characters[at]) ? `\\${characters[at]}` : characters[at]
  }
  return end < characters.length && random() < 0.6 ? `${pattern}*` : pattern
}

export function randomExpressionProbe(random: Random, values: readonly string[]): FieldFilter {
  const caseFold = random() < 0.5
  if (random() < 0.4) return { wildcard: randomWildcard(random, values), caseFold }
  return { regex: randomRegex(random, values), caseFold }
}

export const EXPRESSION_PROBES: FieldFilter[] = [
  { wildcard: 'INV-*-00?' },
  { wildcard: 'inv-*', caseFold: true },
  { wildcard: '*' },
  { wildcard: '' },
  { wildcard: '?' },
  { wildcard: '??' },
  { wildcard: '*ss*', caseFold: true },
  { wildcard: 'STRA*E' },
  { wildcard: 'stra?e', caseFold: true },
  { wildcard: '😀*😀' },
  { wildcard: 'caf?' },
  { wildcard: 'a\\*b' },
  { regex: '' },
  { regex: '^$' },
  { regex: 'INV-\\d{4}-\\d+' },
  { regex: '^inv-<2020-2029>-<1-2>$', caseFold: true },
  { regex: '<0-2024>' },
  { regex: '[ß]', caseFold: true },
  { regex: '^[ß]tra[ß]e$', caseFold: true },
  { regex: 'stra(ss|ß)e', caseFold: true },
  { regex: '[^a-z]', caseFold: true },
  { regex: '\\bball\\b', caseFold: true },
  { regex: '^\\w+$' },
  { regex: '\\s' },
  { regex: 'σ$', caseFold: true },
  { regex: 'refused|full' },
  { regex: '(ab)+' },
  { regex: '^a{2,4}$' },
  { regex: 'a{6}' },
  { regex: '(a|b)*c' },
  { regex: '😀.' },
  { regex: 'caf.' },
  { regex: '[\\d\\s]{2}' },
  { regex: 'i̇', caseFold: true },
  { regex: 'İ', caseFold: true },
  { regex: 'ffi', caseFold: true },
  { regex: '\\.\\d' },
]
