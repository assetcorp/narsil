import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternIndexReader } from '../core/pattern-index/types'
import { SHORTLIST_INTERSECT_RATIO } from './constants'
import type { RunQuery } from './expression/required-runs'
import type { WorkTally } from './work-tally'

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

function shortlistAll(index: PatternIndexReader, runs: Uint32Array, tally: WorkTally): Uint32Array {
  const lists: Uint32Array[] = []
  for (let at = 0; at < runs.length; at += PATTERN_RUN_CODE_POINTS) {
    tally.add(1)
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

function union(left: Uint32Array, right: Uint32Array): Uint32Array {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const merged = new Uint32Array(left.length + right.length)
  let count = 0
  let fromLeft = 0
  let fromRight = 0
  while (fromLeft < left.length && fromRight < right.length) {
    const smaller = Math.min(left[fromLeft], right[fromRight])
    if (left[fromLeft] === smaller) fromLeft++
    if (right[fromRight] === smaller) fromRight++
    merged[count++] = smaller
  }
  while (fromLeft < left.length) merged[count++] = left[fromLeft++]
  while (fromRight < right.length) merged[count++] = right[fromRight++]
  return merged.subarray(0, count)
}

export function shortlist(index: PatternIndexReader, query: RunQuery, tally: WorkTally): Uint32Array | null {
  if (query.kind === 'all') return query.runs.length === 0 ? null : shortlistAll(index, query.runs, tally)
  let candidates: Uint32Array = new Uint32Array(0)
  for (const runs of query.branches) candidates = union(candidates, shortlistAll(index, runs, tally))
  return candidates
}
