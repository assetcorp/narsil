import { bitsetHas, bitsetSet } from '../core/bitset'
import { tabulatedLevenshtein } from '../core/fuzzy'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type {
  PatternHost,
  PatternIndexReader,
  PatternMatchRequest,
  PatternWorkMeter,
} from '../core/pattern-index/types'
import { BASIC_PLANE_LAST, forEachTextValue } from './text'
import { claimsTypoPreparation } from './typo-claims'
import {
  distinctTypoRuns,
  foldTypoText,
  resolvedTypoTolerance,
  type TypoText,
  typoRunLimit,
  typoRunsNeeded,
} from './typo-text'
import type { WorkTally } from './work-tally'

class TypoComparison {
  private readonly text: string
  private readonly shortest: number
  private readonly longest: number
  private readonly folded: number[] = []

  constructor(
    rawText: string,
    prepared: TypoText,
    private readonly caseFold: boolean,
    private readonly tolerance: number,
    private readonly host: PatternHost,
    tally: WorkTally | undefined,
  ) {
    if (caseFold) tally?.add(prepared.folded.length)
    this.text = caseFold ? String.fromCodePoint(...prepared.folded) : rawText
    const length = caseFold ? prepared.folded.length : prepared.codePoints
    this.shortest = length - tolerance
    this.longest = length + tolerance
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

const typoTestsBySearch = new WeakMap<PatternWorkMeter, Map<string, Map<string, TypoTest | null>>>()

function preparedTypoTest(request: PatternMatchRequest, tally: WorkTally | undefined): TypoTest | null {
  const text = foldTypoText(request.text, request.host, tally)
  const distinctRuns = distinctTypoRuns(text, typoRunLimit(text.longestFold), tally)
  const tolerance = resolvedTypoTolerance(
    request.tolerance,
    text.longestFold,
    distinctRuns.length / PATTERN_RUN_CODE_POINTS,
  )
  if (tolerance === 0) return null
  const needed = typoRunsNeeded(tolerance, text.longestFold)
  return {
    needed,
    runs: Uint32Array.from(distinctRuns),
    comparison: new TypoComparison(request.text, text, request.caseFold, tolerance, request.host, tally),
  }
}

function testsWithSettings(request: PatternMatchRequest): Map<string, TypoTest | null> {
  let testsBySettings = typoTestsBySearch.get(request.meter)
  if (testsBySettings === undefined) {
    testsBySettings = new Map()
    typoTestsBySearch.set(request.meter, testsBySettings)
  }
  const settings = `${request.caseFold}|${request.tolerance}`
  let tests = testsBySettings.get(settings)
  if (tests === undefined) {
    tests = new Map()
    testsBySettings.set(settings, tests)
  }
  return tests
}

export function typoTestFor(request: PatternMatchRequest, tally: WorkTally): TypoTest | null {
  const tests = testsWithSettings(request)
  const known = tests.get(request.text)
  if (known !== undefined) return known
  const test = preparedTypoTest(request, claimsTypoPreparation(request) ? tally : undefined)
  tests.set(request.text, test)
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
