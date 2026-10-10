import { describe, expect, it, vi } from 'vitest'
import { bitsetToSet, createBitSet } from '../../core/bitset'
import { MAX_MATCHER_STATE_BYTES } from '../../core/pattern-index/constants'
import { PATTERN_HOST } from '../../core/pattern-index/host'
import type { PatternHost, PatternIndexWriter, PatternOperator } from '../../core/pattern-index/types'
import { createPatternWorkMeter, joinPatternWorkMeter } from '../../core/pattern-index/work-meter'
import { patternSearchModule } from '../../pattern/module'
import { PositionSimulation } from '../../pattern/position-simulation'
import { literalPasses } from '../filters/pattern/fixtures'

const WORK_CAP = 1_000_000_000
const FULL_BUDGET_WORKERS = 1
const THRASHING_BUDGET_WORKERS = 200
const NO_CACHE_BUDGET_WORKERS = MAX_MATCHER_STATE_BYTES

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
    const simulated = vi.spyOn(PositionSimulation.prototype, 'advance')
    const simulatedSteps = { full: 0, thrashing: 0, none: 0 }
    const runCounted = (budget: keyof typeof simulatedSteps, ...args: Parameters<typeof run>) => {
      const before = simulated.mock.calls.length
      const result = run(...args)
      simulatedSteps[budget] += simulated.mock.calls.length - before
      return result
    }
    try {
      for (const text of ['abcab'.repeat(60), 'Straße-ΣΊΣΥΦΟΣ-'.repeat(20), 'aaaaaaaa', 'abab']) {
        const values = nearMisses(text)
        const index = indexOf(values)
        for (const operator of ['eq', 'startsWith', 'endsWith', 'contains'] as const) {
          for (const caseFold of [false, true]) {
            const expected = values.flatMap((value, ordinal) =>
              literalPasses(value, operator, text, caseFold) ? [ordinal] : [],
            )
            const label = `${operator} ${caseFold} ${text.slice(0, 12)}`
            const cached = runCounted('full', values, index, operator, text, caseFold, FULL_BUDGET_WORKERS)
            expect(cached.matched, label).toEqual(expected)
            expect(
              runCounted('thrashing', values, index, operator, text, caseFold, THRASHING_BUDGET_WORKERS),
              label,
            ).toEqual(cached)
            expect(runCounted('none', values, index, operator, text, caseFold, NO_CACHE_BUDGET_WORKERS), label).toEqual(
              cached,
            )
          }
        }
      }
    } finally {
      simulated.mockRestore()
    }
    expect(simulatedSteps.full).toBe(0)
    expect(simulatedSteps.thrashing).toBeGreaterThan(0)
    expect(simulatedSteps.thrashing).toBeLessThan(simulatedSteps.none)
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
    }
    const result = run(values, index, 'startsWith', 'x', true, FULL_BUDGET_WORKERS, countingHost)
    expect(result.matched).toEqual([0])
    expect(folds).toBeLessThanOrEqual(5)
  })
})
