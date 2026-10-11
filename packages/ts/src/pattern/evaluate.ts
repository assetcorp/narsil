import { bitsetHas, bitsetSet } from '../core/bitset'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type {
  PatternHost,
  PatternIndexReader,
  PatternMatchRequest,
  PatternOperator,
  PatternWorkMeter,
} from '../core/pattern-index/types'
import { literalAutomaton } from './automaton'
import { SHORTLIST_INTERSECT_RATIO, SHORTLIST_RUN_LOOKUPS } from './constants'
import { LazyDfa } from './lazy-dfa'
import { appendTextCodePoints, BASIC_PLANE_LAST, forEachTextValue, runKey } from './text'
import { WorkTally } from './work-tally'

const ANCHORED_START: ReadonlySet<PatternOperator> = new Set(['eq', 'startsWith'])
const ANCHORED_END: ReadonlySet<PatternOperator> = new Set(['eq', 'endsWith'])

const shortlistRunsBySearch = new WeakMap<PatternWorkMeter, Map<string, Uint32Array>>()

function spreadRuns(folded: readonly number[]): Uint32Array {
  const runCount = folded.length - PATTERN_RUN_CODE_POINTS + 1
  if (runCount <= 0) return new Uint32Array(0)
  const picks = Math.min(runCount, SHORTLIST_RUN_LOOKUPS)
  const seen = new Set<string>()
  const runs: number[] = []
  for (let pick = 0; pick < picks; pick++) {
    const at = picks === 1 ? 0 : Math.round((pick * (runCount - 1)) / (picks - 1))
    const key = runKey(folded[at], folded[at + 1], folded[at + 2])
    if (seen.has(key)) continue
    seen.add(key)
    runs.push(folded[at], folded[at + 1], folded[at + 2])
  }
  return Uint32Array.from(runs)
}

function shortlistRuns(text: string, host: PatternHost, meter: PatternWorkMeter): Uint32Array {
  let runsByText = shortlistRunsBySearch.get(meter)
  if (runsByText === undefined) {
    runsByText = new Map()
    shortlistRunsBySearch.set(meter, runsByText)
  }
  const known = runsByText.get(text)
  if (known !== undefined) return known
  const folded: number[] = []
  appendTextCodePoints(text, true, host, folded)
  const runs = spreadRuns(folded)
  runsByText.set(text, runs)
  return runs
}

function intersect(candidates: Uint32Array, list: Uint32Array, tally: WorkTally): Uint32Array {
  const kept = new Uint32Array(Math.min(candidates.length, list.length))
  let keptCount = 0
  let read = 0
  for (const candidate of candidates) {
    while (read < list.length && list[read] < candidate) read++
    if (read === list.length) break
    if (list[read] === candidate) kept[keptCount++] = candidate
  }
  tally.add(Math.min(list.length, read + 1))
  return kept.subarray(0, keptCount)
}

function shortlist(index: PatternIndexReader, runs: Uint32Array, tally: WorkTally): Uint32Array | null {
  if (runs.length === 0) return null
  const lists: Uint32Array[] = []
  for (let at = 0; at < runs.length; at += PATTERN_RUN_CODE_POINTS) {
    lists.push(index.postings(runs[at], runs[at + 1], runs[at + 2]))
  }
  lists.sort((left, right) => left.length - right.length)
  let candidates = lists[0]
  tally.add(candidates.length)
  for (let at = 1; at < lists.length && candidates.length > 0; at++) {
    if (lists[at].length > candidates.length * SHORTLIST_INTERSECT_RATIO) break
    candidates = intersect(candidates, lists[at], tally)
  }
  return candidates
}

function matcherFor(request: PatternMatchRequest): LazyDfa {
  const { operator, text, caseFold, host } = request
  const testCodePoints: number[] = []
  appendTextCodePoints(text, caseFold, host, testCodePoints)
  return new LazyDfa(
    literalAutomaton(testCodePoints, ANCHORED_START.has(operator), ANCHORED_END.has(operator)),
    request.meter.matcherStateBytes,
  )
}

function matchesText(
  matcher: LazyDfa,
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

export function matchPattern(request: PatternMatchRequest): void {
  const { text, caseFold, index, matches, host } = request
  const tally = new WorkTally(request.meter)
  const shortlisted = shortlist(index, shortlistRuns(text, host, request.meter), tally)
  const scanning = shortlisted === null
  const candidates = shortlisted ?? index.documents()
  const folded: number[] = []
  let matcher: LazyDfa | null = null
  let matched = false
  const testValue = (value: string): void => {
    if (!matched && matcher !== null) matched = matchesText(matcher, value, caseFold, host, folded, tally)
  }

  for (const ordinal of candidates) {
    if (ordinal >>> 5 >= matches.length || bitsetHas(matches, ordinal)) continue
    if (scanning) tally.add(1)
    matcher ??= matcherFor(request)
    matched = false
    forEachTextValue(request.valueOf(ordinal), testValue)
    if (matched) bitsetSet(matches, ordinal)
  }
  tally.flush()
}
