import { bitsetHas, bitsetSet } from '../core/bitset'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternHost, PatternIndexReader, PatternMatchRequest, PatternOperator } from '../core/pattern-index/types'
import { literalAutomaton } from './automaton'
import { SHORTLIST_INTERSECT_RATIO } from './constants'
import { LazyDfa } from './lazy-dfa'
import { appendTextCodePoints, BASIC_PLANE_LAST, forEachTextValue, runKey } from './text'
import { WorkTally } from './work-tally'

const ANCHORED_START: ReadonlySet<PatternOperator> = new Set(['eq', 'startsWith'])
const ANCHORED_END: ReadonlySet<PatternOperator> = new Set(['eq', 'endsWith'])

function distinctRunLists(index: PatternIndexReader, folded: readonly number[]): Uint32Array[] {
  const seen = new Set<string>()
  const lists: Uint32Array[] = []
  for (let at = 0; at + PATTERN_RUN_CODE_POINTS <= folded.length; at++) {
    const key = runKey(folded[at], folded[at + 1], folded[at + 2])
    if (seen.has(key)) continue
    seen.add(key)
    lists.push(index.postings(folded[at], folded[at + 1], folded[at + 2]))
  }
  return lists.sort((left, right) => left.length - right.length)
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

function shortlist(index: PatternIndexReader, folded: readonly number[], tally: WorkTally): Uint32Array | null {
  const lists = distinctRunLists(index, folded)
  if (lists.length === 0) return null
  let candidates = lists[0]
  tally.add(candidates.length)
  for (let at = 1; at < lists.length && candidates.length > 0; at++) {
    if (lists[at].length > candidates.length * SHORTLIST_INTERSECT_RATIO) break
    candidates = intersect(candidates, lists[at], tally)
  }
  return candidates
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
  const { operator, text, caseFold, index, matches, host } = request
  const tally = new WorkTally(request.meter)

  const testCodePoints: number[] = []
  appendTextCodePoints(text, caseFold, host, testCodePoints)
  const foldedTest: number[] = []
  appendTextCodePoints(text, true, host, foldedTest)

  const matcher = new LazyDfa(
    literalAutomaton(testCodePoints, ANCHORED_START.has(operator), ANCHORED_END.has(operator)),
    request.meter.matcherStateBytes,
  )
  const shortlisted = shortlist(index, foldedTest, tally)
  const scanning = shortlisted === null
  const candidates = shortlisted ?? index.documents()
  const folded: number[] = []
  let matched = false
  const testValue = (value: string): void => {
    if (!matched) matched = matchesText(matcher, value, caseFold, host, folded, tally)
  }

  for (const ordinal of candidates) {
    if (ordinal >>> 5 >= matches.length || bitsetHas(matches, ordinal)) continue
    if (scanning) tally.add(1)
    matched = false
    forEachTextValue(request.valueOf(ordinal), testValue)
    if (matched) bitsetSet(matches, ordinal)
  }
  tally.flush()
}
