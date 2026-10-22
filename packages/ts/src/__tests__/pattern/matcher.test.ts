import { describe, expect, it, vi } from 'vitest'
import { bitsetToSet, createBitSet } from '../../core/bitset'
import { MATCHER_STATE_BUDGET_BYTES, MAX_PATTERN_POSITIONS } from '../../core/pattern-index/constants'
import { PATTERN_HOST } from '../../core/pattern-index/host'
import { smallestMatcherBytes, widestPatternSplit } from '../../core/pattern-index/matcher-budget'
import type {
  PatternHost,
  PatternIndexReader,
  PatternIndexWriter,
  PatternOperator,
  PatternWorkMeter,
} from '../../core/pattern-index/types'
import { createPatternWorkMeter, joinPatternWorkMeter } from '../../core/pattern-index/work-meter'
import { SHORTLIST_RUN_LOOKUPS } from '../../pattern/constants'
import { compileExpression, programFootprint } from '../../pattern/expression'
import { LazyDfa } from '../../pattern/lazy-dfa'
import { patternSearchModule } from '../../pattern/module'
import { WorkTally } from '../../pattern/work-tally'
import { literalPasses } from '../filters/pattern/fixtures'
import { seededRandom } from '../filters/pattern/random-corpus'

const WORK_CAP = 1_000_000_000
const FULL_BUDGET_WORKERS = 1
const THRASHING_BUDGET_WORKERS = 200
const NO_CACHE_BUDGET_WORKERS = MATCHER_STATE_BUDGET_BYTES
const CJK_FIRST = 0x4e00
const LATIN_EXTENDED_FIRST = 0x0100

function distinctText(length: number, first: number): string {
  return String.fromCodePoint(...Array.from({ length }, (_, at) => first + at))
}

function indexOf(values: readonly string[]): PatternIndexWriter {
  const index = patternSearchModule.createIndex(PATTERN_HOST)
  for (const [ordinal, value] of values.entries()) index.add(ordinal, value)
  return index
}

function run(
  values: readonly string[],
  index: PatternIndexWriter,
  operator: PatternOperator,
  text: string,
  caseFold: boolean,
  budgetWorkers: number,
  host: PatternHost = PATTERN_HOST,
) {
  const meter = joinPatternWorkMeter(createPatternWorkMeter(WORK_CAP).fork(budgetWorkers).shared)
  const matches = createBitSet(values.length)
  patternSearchModule.matchInto({
    operator,
    text,
    caseFold,
    index,
    matches,
    meter,
    host,
    valueOf: ordinal => values[ordinal],
  })
  return { matched: [...bitsetToSet(matches)].sort((left, right) => left - right), spent: meter.spent() }
}

function nearMisses(text: string): string[] {
  const characters = Array.from(text)
  const values: string[] = []
  for (let at = 0; at < characters.length; at += 7) {
    const changed = [...characters]
    changed[at] = 'Q'
    values.push(changed.join(''), changed.join('').toUpperCase(), `x${changed.join('')}`)
  }
  values.push(text, text.toUpperCase(), `${text}${text}`, `zz${text}zz`)
  return values
}

describe('the pattern matcher', () => {
  it('returns the same documents and counts the same work whatever the state budget', () => {
    for (const text of ['abcab'.repeat(60), 'Straße-ΣΊΣΥΦΟΣ-'.repeat(20), 'aaaaaaaa', 'abab']) {
      const values = nearMisses(text)
      const index = indexOf(values)
      for (const operator of ['eq', 'startsWith', 'endsWith', 'contains'] as const) {
        for (const caseFold of [false, true]) {
          const expected = values.flatMap((value, ordinal) =>
            literalPasses(value, operator, text, caseFold) ? [ordinal] : [],
          )
          const label = `${operator} ${caseFold} ${text.slice(0, 12)}`
          const full = run(values, index, operator, text, caseFold, FULL_BUDGET_WORKERS)
          expect(full.matched, label).toEqual(expected)
          expect(run(values, index, operator, text, caseFold, THRASHING_BUDGET_WORKERS), label).toEqual(full)
          expect(run(values, index, operator, text, caseFold, NO_CACHE_BUDGET_WORKERS), label).toEqual(full)
        }
      }
    }
  })

  it('reads a value only as far as the answer needs', () => {
    const values = [`X${'y'.repeat(8_000)}`, `Z${'y'.repeat(8_000)}`]
    const index = indexOf(values)
    let folds = 0
    const countingHost: PatternHost = {
      appendFoldedCodePoint(codePoint, out) {
        folds++
        PATTERN_HOST.appendFoldedCodePoint(codePoint, out)
      },
      singleFoldSources: folded => PATTERN_HOST.singleFoldSources(folded),
    }
    const result = run(values, index, 'startsWith', 'x', true, FULL_BUDGET_WORKERS, countingHost)
    expect(result.matched).toEqual([0])
    expect(folds).toBeLessThanOrEqual(5)
  })

  it('keeps the longest literal test within the share of state that each copy gets in the widest split', () => {
    const widest = widestPatternSplit(smallestMatcherBytes(MAX_PATTERN_POSITIONS))
    const doubleFolds = ['ß', 'ﬀ', 'ﬁ', 'ﬂ', 'ﬆ']
    const text = Array.from(
      { length: MAX_PATTERN_POSITIONS / 2 },
      (_, at) => doubleFolds[at % doubleFolds.length],
    ).join('')
    const values = [text, text.toUpperCase(), `${text.slice(0, -1)}x`, `x${text}`, `${text}${text}`, 'ss']
    const index = indexOf(values)
    for (const operator of ['eq', 'startsWith', 'endsWith', 'contains'] as const) {
      expect(run(values, index, operator, text, true, widest), operator).toEqual(
        run(values, index, operator, text, true, FULL_BUDGET_WORKERS),
      )
    }
  })

  it('holds at most the state budget for one search, and at most the share of each copy once the search splits', () => {
    const random = seededRandom(5)
    const values = Array.from({ length: 4 }, () =>
      Array.from({ length: 4_000 }, () => (random() < 0.5 ? 'a' : 'b')).join(''),
    )
    for (const pattern of [`[ab]*a[ab]{${MAX_PATTERN_POSITIONS - 2}}`, '(a|b)*a(a|b){20}c', '((a|b)(a|b)){511}c']) {
      const { program } = compileExpression('regex', pattern, false, PATTERN_HOST)
      const footprint = programFootprint(program)
      const share = Math.floor(MATCHER_STATE_BUDGET_BYTES / widestPatternSplit(footprint))
      expect(footprint, pattern).toBeLessThanOrEqual(share)
      for (const limit of [MATCHER_STATE_BUDGET_BYTES, share]) {
        const dfa = new LazyDfa(program, limit)
        const tally = new WorkTally(createPatternWorkMeter(WORK_CAP))
        let largest = dfa.heldBytes
        for (const value of values) {
          dfa.begin()
          for (const character of value) {
            if (!dfa.feed(character.codePointAt(0) ?? 0, tally)) break
            largest = Math.max(largest, dfa.heldBytes)
          }
          dfa.matched()
        }
        expect(largest, `${pattern} ${limit}`).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('counts one step for each position that a match can reach at each code point that it checks', () => {
    const values = ['xxabc', 'xxabd']
    const index = indexOf(values)
    const meter = joinPatternWorkMeter(createPatternWorkMeter(WORK_CAP).fork(1).shared)
    const matches = createBitSet(values.length)
    patternSearchModule.matchInto({
      operator: 'regex',
      text: 'abc',
      caseFold: false,
      index,
      matches,
      meter,
      host: PATTERN_HOST,
      valueOf: ordinal => values[ordinal],
    })
    expect([...bitsetToSet(matches)]).toEqual([0])
    const lookups = 1
    const shortlistEntries = 1
    const steps = 1 + 1 + 1 + 2 + 2
    expect(meter.spent()).toBe(lookups + shortlistEntries + steps)
  })

  it('builds each state in time that grows with the steps that it counts, however long the pattern is', () => {
    const { program } = compileExpression('regex', distinctText(MAX_PATTERN_POSITIONS, CJK_FIRST), false, PATTERN_HOST)
    const dfa = new LazyDfa(program, MATCHER_STATE_BUDGET_BYTES)
    const meter = createPatternWorkMeter(WORK_CAP)
    const tally = new WorkTally(meter)
    const join = Uint32Array.prototype.join
    let keyCharacters = 0
    const joined = vi.spyOn(Uint32Array.prototype, 'join').mockImplementation(function (
      this: Uint32Array,
      separator?: string,
    ) {
      const key = join.call(this, separator)
      keyCharacters += key.length
      return key
    })
    try {
      dfa.begin()
      for (const character of distinctText(2_000, LATIN_EXTENDED_FIRST)) dfa.feed(character.codePointAt(0) ?? 0, tally)
    } finally {
      joined.mockRestore()
    }
    tally.flush()
    const units = WORK_CAP - meter.remaining()
    expect(units).toBe(2_000)
    expect(keyCharacters).toBeLessThanOrEqual(4 * units)
  })

  it('folds a test once in a search, and counts only its run lookups where no document holds its runs', () => {
    const values = ['plain value', 'another value']
    let folds = 0
    let lookups = 0
    const countingHost: PatternHost = {
      appendFoldedCodePoint(codePoint, out) {
        folds++
        PATTERN_HOST.appendFoldedCodePoint(codePoint, out)
      },
      singleFoldSources: folded => PATTERN_HOST.singleFoldSources(folded),
    }
    const counting = (index: PatternIndexWriter): PatternIndexReader => ({
      documents: () => index.documents(),
      postings(first, second, third) {
        lookups++
        return index.postings(first, second, third)
      },
      toArrays: (fieldPath, remap) => index.toArrays(fieldPath, remap),
      bytes: () => index.bytes(),
    })
    const text = distinctText(1_024, CJK_FIRST)
    const meter = joinPatternWorkMeter(createPatternWorkMeter(WORK_CAP).fork(1).shared)
    for (const index of [indexOf(values), indexOf(values)]) {
      const matches = createBitSet(values.length)
      patternSearchModule.matchInto({
        operator: 'contains',
        text,
        caseFold: true,
        index: counting(index),
        matches,
        meter,
        host: countingHost,
        valueOf: ordinal => values[ordinal],
      })
      expect(bitsetToSet(matches).size).toBe(0)
    }
    expect(folds).toBe(1_024)
    expect(lookups).toBeLessThanOrEqual(2 * SHORTLIST_RUN_LOOKUPS)
    expect(meter.spent()).toBe(lookups)
  })

  it('reports work to a count that copies share at the share of the flush interval that each copy gets', () => {
    const copies = 64
    const shared = joinPatternWorkMeter(createPatternWorkMeter(WORK_CAP).fork(copies).shared)
    const reports: number[] = []
    const recording: PatternWorkMeter = {
      matcherStateBytes: shared.matcherStateBytes,
      flushUnits: shared.flushUnits,
      add(units) {
        reports.push(units)
        shared.add(units)
      },
      remaining: () => shared.remaining(),
    }
    const values = Array.from({ length: 20 }, () => `${'ab'.repeat(4_000)}x`)
    const matches = createBitSet(values.length)
    patternSearchModule.matchInto({
      operator: 'endsWith',
      text: 'abx',
      caseFold: false,
      index: indexOf(values),
      matches,
      meter: recording,
      host: PATTERN_HOST,
      valueOf: ordinal => values[ordinal],
    })
    expect(bitsetToSet(matches).size).toBe(values.length)
    expect(shared.spent()).toBeGreaterThan(20 * shared.flushUnits)
    expect(Math.max(...reports)).toBeLessThanOrEqual(shared.flushUnits + 'abx'.length)
  })
})
