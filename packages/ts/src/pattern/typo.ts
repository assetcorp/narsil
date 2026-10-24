import { bitsetHas, bitsetSet } from '../core/bitset'
import { tabulatedLevenshtein } from '../core/fuzzy'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type {
  PatternHost,
  PatternIndexReader,
  PatternMatchRequest,
  PatternWorkMeter,
} from '../core/pattern-index/types'
import { distinctTypoRuns, foldTypoText, resolvedTypoTolerance, typoRunsNeeded } from '../core/pattern-index/typo-runs'
import { SHORTLIST_RUN_LOOKUPS } from './constants'
import { appendTextCodePoints, BASIC_PLANE_LAST, forEachTextValue } from './text'
import type { WorkTally } from './work-tally'

class TypoComparison {
  private readonly text: string
  private readonly shortest: number
  private readonly longest: number
  private readonly folded: number[] = []

  constructor(
    text: string,
    private readonly caseFold: boolean,
    private readonly tolerance: number,
    private readonly host: PatternHost,
  ) {
    const codePoints: number[] = []
    appendTextCodePoints(text, caseFold, host, codePoints)
    this.text = caseFold ? String.fromCodePoint(...codePoints) : text
    this.shortest = codePoints.length - tolerance
    this.longest = codePoints.length + tolerance
  }

  within(value: string, tally: WorkTally): boolean {
    const compared = this.comparedForm(value)
    if (compared === null) return false
    const { withinTolerance, cells } = tabulatedLevenshtein(this.text, compared, this.tolerance)
    tally.add(cells)
    return withinTolerance
  }

  private comparedForm(value: string): string | null {
    const folded = this.folded
    folded.length = 0
    let counted = 0
    for (let at = 0; at < value.length && counted <= this.longest; at++) {
      const codePoint = value.codePointAt(at) ?? 0
      if (codePoint > BASIC_PLANE_LAST) at++
      if (this.caseFold) {
        this.host.appendFoldedCodePoint(codePoint, folded)
        counted = folded.length
      } else {
        counted++
      }
    }
    if (counted > this.longest || counted < this.shortest) return null
    return this.caseFold ? String.fromCodePoint(...folded) : value
  }
}

interface TypoTest {
  readonly needed: number
  readonly runs: Uint32Array
  readonly comparison: TypoComparison
}

const typoTestsBySearch = new WeakMap<PatternWorkMeter, Map<string, TypoTest | null>>()

function spreadSample(runs: readonly number[], picks: number): Uint32Array {
  const count = runs.length / PATTERN_RUN_CODE_POINTS
  if (count <= picks) return Uint32Array.from(runs)
  const sample = new Uint32Array(picks * PATTERN_RUN_CODE_POINTS)
  for (let pick = 0; pick < picks; pick++) {
    const run = Math.round((pick * (count - 1)) / (picks - 1))
    for (let offset = 0; offset < PATTERN_RUN_CODE_POINTS; offset++) {
      sample[pick * PATTERN_RUN_CODE_POINTS + offset] = runs[run * PATTERN_RUN_CODE_POINTS + offset]
    }
  }
  return sample
}

function preparedTypoTest(request: PatternMatchRequest): TypoTest | null {
  const text = foldTypoText(request.text, request.host)
  const tolerance = resolvedTypoTolerance(request.tolerance, text)
  if (tolerance === 0) return null
  const needed = typoRunsNeeded(tolerance, text.longestFold)
  return {
    needed,
    runs: spreadSample(distinctTypoRuns(text, Number.POSITIVE_INFINITY), Math.max(needed, SHORTLIST_RUN_LOOKUPS)),
    comparison: new TypoComparison(request.text, request.caseFold, tolerance, request.host),
  }
}

export function typoTestFor(request: PatternMatchRequest): TypoTest | null {
  let tests = typoTestsBySearch.get(request.meter)
  if (tests === undefined) {
    tests = new Map()
    typoTestsBySearch.set(request.meter, tests)
  }
  const key = `${request.caseFold}|${request.tolerance}|${request.text}`
  const known = tests.get(key)
  if (known !== undefined) return known
  const test = preparedTypoTest(request)
  tests.set(key, test)
  return test
}

function rarestLists(index: PatternIndexReader, test: TypoTest, tally: WorkTally): readonly Uint32Array[] {
  const { runs, needed } = test
  if (runs.length < needed * PATTERN_RUN_CODE_POINTS) return [index.documents()]
  const lists: Uint32Array[] = []
  for (let at = 0; at < runs.length; at += PATTERN_RUN_CODE_POINTS) {
    tally.add(1)
    lists.push(index.postings(runs[at], runs[at + 1], runs[at + 2]))
  }
  lists.sort((left, right) => left.length - right.length)
  return lists.slice(0, needed)
}

export function matchWithinTolerance(request: PatternMatchRequest, test: TypoTest, tally: WorkTally): void {
  const { index, matches } = request
  const checked = new Uint32Array(matches.length)
  let matched = false
  const testValue = (value: string): void => {
    if (!matched) matched = test.comparison.within(value, tally)
  }

  for (const list of rarestLists(index, test, tally)) {
    tally.add(list.length)
    for (const ordinal of list) {
      if (ordinal >>> 5 >= matches.length || bitsetHas(checked, ordinal)) continue
      bitsetSet(checked, ordinal)
      if (bitsetHas(matches, ordinal)) continue
      matched = false
      forEachTextValue(request.valueOf(ordinal), testValue)
      if (matched) bitsetSet(matches, ordinal)
    }
  }
}
