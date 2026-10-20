import { RE2 } from 're2-wasm'
import { describe, expect, it } from 'vitest'
import { bitsetToSet, createBitSet } from '../../core/bitset'
import { MATCHER_STATE_BUDGET_BYTES } from '../../core/pattern-index/constants'
import { PATTERN_HOST } from '../../core/pattern-index/host'
import type { PatternIndexWriter } from '../../core/pattern-index/types'
import { createPatternWorkMeter, joinPatternWorkMeter } from '../../core/pattern-index/work-meter'
import { patternSearchModule } from '../../pattern/module'
import { type Random, seededRandom } from '../filters/pattern/random-corpus'

const WORK_CAP = 1_000_000_000_000
const SEEDS = [3, 17, 256, 4_099, 65_537]
const PATTERNS_PER_SEED = 400
const VALUES_PER_SEED = 160
const SMALL_RANGE_HIGH = 120
const BUDGETS = [1, 400, MATCHER_STATE_BUDGET_BYTES]
const MIN_SPLITTING_SHARE = 0.4

const VALUE_PIECES = ['a', 'b', 'c', 'ab', 'abc', 'A', 'B', '0', '1', '7', '9', '42', '007', ' ', '\n', '\t', '-']
for (const piece of ['_', '.', '[', ']', '^', '$', '\\', 'é', 'ß', '😀', 'xyz', 'port=80', 'INV-2024']) {
  VALUE_PIECES.push(piece)
}
const LITERALS = ['a', 'b', 'c', 'A', '0', '1', '7', '9', ' ', '-', '_', 'é', 'ß', '😀', '=', ',', 'x']
const ESCAPED = ['\\.', '\\-', '\\[', '\\]', '\\^', '\\$', '\\\\', '\\*', '\\(', '\\)', '\\<', '\\>', '\\{', '\\}']
const SET_MEMBERS = ['a', 'b', 'c', 'A', '0', '9', ' ', '_', 'é', '😀', '\\-', '\\]', '\\[', '\\\\', '\\^', '.']
const CLASSES = ['\\d', '\\w', '\\s']

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function below(random: Random, limit: number): number {
  return Math.floor(random() * limit)
}

function randomValue(random: Random): string {
  let value = ''
  const pieces = below(random, 12)
  for (let at = 0; at < pieces; at++) value += pick(random, VALUE_PIECES)
  return value
}

function acceptedNumbers(low: string, high: string): string[] {
  const numbers: string[] = []
  for (let value = Number(low); value <= Number(high); value++) {
    numbers.push(low.length === high.length ? String(value).padStart(low.length, '0') : String(value))
  }
  return numbers
}

interface Generated {
  readonly narsil: string
  readonly re2: string
}

function randomSet(random: Random): Generated {
  const negated = random() < 0.3 ? '^' : ''
  const items: string[] = []
  const count = 1 + below(random, 4)
  for (let at = 0; at < count; at++) {
    const roll = random()
    if (roll < 0.2) items.push(pick(random, CLASSES))
    else if (roll < 0.4) items.push(pick(random, ['a-c', '0-7', 'A-Z', 'a-a', '\\--\\.']))
    else items.push(pick(random, SET_MEMBERS))
  }
  const text = `[${negated}${items.join('')}]`
  return { narsil: text, re2: text }
}

function randomNumberRange(random: Random): Generated {
  const width = 1 + below(random, 3)
  const highValue = below(random, SMALL_RANGE_HIGH)
  const lowValue = below(random, highValue + 1)
  const sameWidth = random() < 0.4
  const low = sameWidth ? String(lowValue).padStart(Math.max(width, String(highValue).length), '0') : String(lowValue)
  const high = sameWidth ? String(highValue).padStart(low.length, '0') : String(highValue)
  return { narsil: `<${low}-${high}>`, re2: `(?:${acceptedNumbers(low, high).join('|')})` }
}

function randomAtom(random: Random, depth: number): Generated {
  const roll = random()
  if (roll < 0.3) {
    const literal = pick(random, LITERALS)
    return { narsil: literal, re2: literal }
  }
  if (roll < 0.38) {
    const escaped = pick(random, ESCAPED)
    return { narsil: escaped, re2: escaped }
  }
  if (roll < 0.45) return { narsil: '.', re2: '.' }
  if (roll < 0.53) {
    const name = pick(random, CLASSES)
    return { narsil: name, re2: name }
  }
  if (roll < 0.63) return randomSet(random)
  if (roll < 0.7) {
    const anchor = pick(random, ['^', '$', '\\b'])
    return { narsil: anchor, re2: anchor }
  }
  if (roll < 0.78) return randomNumberRange(random)
  if (depth >= 3) return { narsil: 'a', re2: 'a' }
  const inner = randomPattern(random, depth + 1)
  return { narsil: `(${inner.narsil})`, re2: `(${inner.re2})` }
}

function randomRepeat(random: Random): string {
  const roll = random()
  if (roll < 0.55) return ''
  if (roll < 0.65) return '*'
  if (roll < 0.75) return '+'
  if (roll < 0.85) return '?'
  const low = below(random, 4)
  const shape = below(random, 3)
  if (shape === 0) return `{${low}}`
  if (shape === 1) return `{${low},}`
  return `{${low},${low + below(random, 4)}}`
}

function randomPattern(random: Random, depth: number): Generated {
  const branches: Generated[] = []
  const branchCount = random() < 0.25 ? 2 + below(random, 2) : 1
  for (let branch = 0; branch < branchCount; branch++) {
    let narsil = ''
    let re2 = ''
    const pieces = 1 + below(random, 4)
    for (let piece = 0; piece < pieces; piece++) {
      const atom = randomAtom(random, depth)
      const repeat = randomRepeat(random)
      narsil += atom.narsil + repeat
      re2 += atom.re2 + repeat
    }
    branches.push({ narsil, re2 })
  }
  return {
    narsil: branches.map(branch => branch.narsil).join('|'),
    re2: branches.map(branch => branch.re2).join('|'),
  }
}

function indexOf(values: readonly string[]): PatternIndexWriter {
  const index = patternSearchModule.createIndex(PATTERN_HOST)
  for (const [ordinal, value] of values.entries()) index.add(ordinal, value)
  return index
}

function narsilMatches(values: readonly string[], index: PatternIndexWriter, pattern: string, budget: number) {
  const meter = joinPatternWorkMeter(createPatternWorkMeter(WORK_CAP).fork(budget).shared)
  const matches = createBitSet(values.length)
  patternSearchModule.matchInto({
    operator: 'regex',
    text: pattern,
    caseFold: false,
    index,
    matches,
    meter,
    host: PATTERN_HOST,
    valueOf: ordinal => values[ordinal],
  })
  return [...bitsetToSet(matches)].sort((left, right) => left - right)
}

interface WasmHandle {
  readonly wrapper: { delete(): void }
}

function re2Matches(values: readonly string[], pattern: string): number[] {
  const expression = new RE2(pattern, 'su')
  try {
    return values.flatMap((value, ordinal) => (expression.test(value) ? [ordinal] : []))
  } finally {
    ;(expression as unknown as WasmHandle).wrapper.delete()
  }
}

describe('the regular expression matcher', () => {
  it.each(SEEDS)('agrees with RE2 under its s flag on random patterns and values (seed %i)', seed => {
    const random = seededRandom(seed)
    const values = Array.from({ length: VALUES_PER_SEED }, () => randomValue(random))
    values.push('', 'port=65535', 'port=080', 'a\nb', '😀😀', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab')
    const index = indexOf(values)
    let splitting = 0
    for (let round = 0; round < PATTERNS_PER_SEED; round++) {
      const pattern = randomPattern(random, 0)
      const expected = re2Matches(values, pattern.re2)
      const budget = BUDGETS[round % BUDGETS.length]
      expect(narsilMatches(values, index, pattern.narsil, budget), `${pattern.narsil} / ${pattern.re2}`).toEqual(
        expected,
      )
      if (expected.length > 0 && expected.length < values.length) splitting++
    }
    expect(splitting).toBeGreaterThan(PATTERNS_PER_SEED * MIN_SPLITTING_SHARE)
  })

  it('agrees with RE2 on patterns whose deterministic states outgrow the state budget', () => {
    const random = seededRandom(9)
    const values = Array.from({ length: 30 }, () =>
      Array.from({ length: 600 }, () => (random() < 0.5 ? 'a' : 'b')).join(''),
    )
    values.push('a'.repeat(600), 'b'.repeat(600), `${'b'.repeat(599)}a`)
    const index = indexOf(values)
    for (const pattern of ['[ab]*a[ab]{14}$', '^(a|b)*a(a|b){10}b$', '(a|b|ab|ba)*a{3}b{3}', '\\ba[ab]{12}a\\b']) {
      const expected = re2Matches(values, pattern)
      for (const budget of BUDGETS) {
        expect(narsilMatches(values, index, pattern, budget), `${pattern} ${budget}`).toEqual(expected)
      }
    }
  })
})
