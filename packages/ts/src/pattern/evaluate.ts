import { bitsetHas, bitsetSet } from '../core/bitset'
import type {
  ExpressionOperator,
  PatternHost,
  PatternMatchRequest,
  PatternOperator,
  PatternWorkMeter,
} from '../core/pattern-index/types'
import { type RunQuery, spreadRuns } from './expression'
import { searchExpressions } from './expression-cache'
import { LiteralMatcher } from './literal-matcher'
import { shortlist } from './shortlist'
import { appendTextCodePoints, BASIC_PLANE_LAST, forEachTextValue } from './text'
import { matchWithinTolerance, typoTestFor } from './typo'
import { WorkTally } from './work-tally'

interface ValueMatcher {
  begin(): boolean
  feed(codePoint: number, tally: WorkTally): boolean
  matched(): boolean
}

interface PreparedTest {
  readonly runs: RunQuery
  matcher(): ValueMatcher
}

const ANCHORED_START: ReadonlySet<PatternOperator> = new Set(['eq', 'startsWith'])
const ANCHORED_END: ReadonlySet<PatternOperator> = new Set(['eq', 'endsWith'])

const shortlistRunsBySearch = new WeakMap<PatternWorkMeter, Map<string, RunQuery>>()

function literalRuns(text: string, host: PatternHost, meter: PatternWorkMeter): RunQuery {
  let runsByText = shortlistRunsBySearch.get(meter)
  if (runsByText === undefined) {
    runsByText = new Map()
    shortlistRunsBySearch.set(meter, runsByText)
  }
  const known = runsByText.get(text)
  if (known !== undefined) return known
  const folded: number[] = []
  appendTextCodePoints(text, true, host, folded)
  const runs: RunQuery = { kind: 'all', runs: spreadRuns([folded]) }
  runsByText.set(text, runs)
  return runs
}

function literalTest(request: PatternMatchRequest): PreparedTest {
  const { operator, text, caseFold, host, meter } = request
  return {
    runs: literalRuns(text, host, meter),
    matcher: () => {
      const testCodePoints: number[] = []
      appendTextCodePoints(text, caseFold, host, testCodePoints)
      return new LiteralMatcher(
        Uint32Array.from(testCodePoints),
        ANCHORED_START.has(operator),
        ANCHORED_END.has(operator),
      )
    },
  }
}

function expressionTest(request: PatternMatchRequest, operator: ExpressionOperator): PreparedTest {
  const { text, caseFold, host, meter } = request
  const expressions = searchExpressions(meter)
  const entry = expressions.expression(operator, text, caseFold, host)
  return { runs: entry.prepared.runs, matcher: () => expressions.matcher(entry) }
}

function matchesText(
  matcher: ValueMatcher,
  text: string,
  caseFold: boolean,
  host: PatternHost,
  folded: number[],
  tally: WorkTally,
): boolean {
  if (!matcher.begin()) return matcher.matched()
  for (let at = 0; at < text.length; at++) {
    const codePoint = text.codePointAt(at) ?? 0
    if (codePoint > BASIC_PLANE_LAST) at++
    if (!caseFold) {
      if (!matcher.feed(codePoint, tally)) return matcher.matched()
      continue
    }
    folded.length = 0
    host.appendFoldedCodePoint(codePoint, folded)
    for (const foldedCodePoint of folded) {
      if (!matcher.feed(foldedCodePoint, tally)) return matcher.matched()
    }
  }
  return matcher.matched()
}

function answeredByTypoTest(request: PatternMatchRequest, tally: WorkTally): boolean {
  if (request.operator !== 'eq' || request.tolerance === 0) return false
  const test = typoTestFor(request)
  if (test === null) return false
  matchWithinTolerance(request, test, tally)
  return true
}

export function matchPattern(request: PatternMatchRequest): void {
  const { operator, caseFold, index, matches, host } = request
  const tally = new WorkTally(request.meter)
  if (answeredByTypoTest(request, tally)) {
    tally.flush()
    return
  }
  const test =
    operator === 'wildcard' || operator === 'regex' ? expressionTest(request, operator) : literalTest(request)
  const shortlisted = shortlist(index, test.runs, tally)
  const scanning = shortlisted === null
  const candidates = shortlisted ?? index.documents()
  const folded: number[] = []
  let matcher: ValueMatcher | null = null
  let matched = false
  const testValue = (value: string): void => {
    if (!matched && matcher !== null) matched = matchesText(matcher, value, caseFold, host, folded, tally)
  }

  for (const ordinal of candidates) {
    if (ordinal >>> 5 >= matches.length || bitsetHas(matches, ordinal)) continue
    if (scanning) tally.add(1)
    matcher ??= test.matcher()
    matched = false
    forEachTextValue(request.valueOf(ordinal), testValue)
    if (matched) bitsetSet(matches, ordinal)
  }
  tally.flush()
}
