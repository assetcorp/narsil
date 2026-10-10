import { bitsetSet, createBitSet } from '../core/bitset'
import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternIndexReader, PatternMatchRequest, PatternOperator } from '../core/pattern-index/types'
import { literalAutomaton } from './automaton'
import { SHORTLIST_INTERSECT_RATIO } from './constants'
import { LazyDfa } from './lazy-dfa'
import { appendTextCodePoints, forEachTextValue, runKey } from './text'
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

export function matchPatternBitset(request: PatternMatchRequest): Uint32Array {
  const { operator, text, caseFold, index, capacity, host } = request
  const tally = new WorkTally(request.meter)
  const result = createBitSet(capacity)

  const testCodePoints: number[] = []
  appendTextCodePoints(text, caseFold, host, testCodePoints)
  const foldedTest: number[] = []
  host.appendFolded(text, foldedTest)

  const matcher = new LazyDfa(
    literalAutomaton(testCodePoints, ANCHORED_START.has(operator), ANCHORED_END.has(operator)),
    request.meter.matcherStateBytes,
  )
  const candidates = shortlist(index, foldedTest, tally) ?? index.documents()
  const valueCodePoints: number[] = []
  let matched = false
  const testValue = (value: string): void => {
    if (matched) return
    valueCodePoints.length = 0
    appendTextCodePoints(value, caseFold, host, valueCodePoints)
    matched = matcher.matches(valueCodePoints, valueCodePoints.length, tally)
  }

  for (const ordinal of candidates) {
    if (ordinal >= capacity) continue
    matched = false
    forEachTextValue(request.valueOf(ordinal), testValue)
    if (matched) bitsetSet(result, ordinal)
  }
  tally.flush()
  return result
}
