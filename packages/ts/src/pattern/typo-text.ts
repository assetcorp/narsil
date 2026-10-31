import { MAX_PATTERN_TOLERANCE, PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternHost, PatternTolerance } from '../core/pattern-index/types'
import { SHORTLIST_RUN_LOOKUPS } from './constants'
import { BASIC_PLANE_LAST } from './text'
import type { WorkTally } from './work-tally'

export interface TypoText {
  readonly codePoints: number
  readonly folded: readonly number[]
  readonly longestFold: number
}

export function foldTypoText(text: string, host: PatternHost, tally?: WorkTally): TypoText {
  const folded: number[] = []
  let codePoints = 0
  let longestFold = 0
  for (let at = 0; at < text.length; at++) {
    tally?.add(1)
    const codePoint = text.codePointAt(at) ?? 0
    if (codePoint > BASIC_PLANE_LAST) at++
    const before = folded.length
    host.appendFoldedCodePoint(codePoint, folded)
    codePoints++
    longestFold = Math.max(longestFold, folded.length - before)
  }
  return { codePoints, folded, longestFold }
}

function holdsRun(runs: readonly number[], first: number, second: number, third: number): boolean {
  for (let at = 0; at < runs.length; at += PATTERN_RUN_CODE_POINTS) {
    if (runs[at] === first && runs[at + 1] === second && runs[at + 2] === third) return true
  }
  return false
}

function keepDistinctRun(runs: number[], folded: readonly number[], at: number, tally: WorkTally | undefined): void {
  tally?.add(1)
  const first = folded[at]
  const second = folded[at + 1]
  const third = folded[at + 2]
  if (!holdsRun(runs, first, second, third)) runs.push(first, second, third)
}

export function distinctTypoRuns(text: TypoText, limit: number, tally?: WorkTally): number[] {
  const { folded } = text
  const positions = folded.length - PATTERN_RUN_CODE_POINTS + 1
  const wanted = limit * PATTERN_RUN_CODE_POINTS
  const runs: number[] = []
  if (positions > limit && limit > 1) {
    for (let pick = 0; pick < limit; pick++) {
      keepDistinctRun(runs, folded, Math.round((pick * (positions - 1)) / (limit - 1)), tally)
    }
  }
  for (let at = 0; at < positions && runs.length < wanted; at++) keepDistinctRun(runs, folded, at, tally)
  return runs
}

export function typoRunLimit(longestFold: number): number {
  return Math.max(typoRunsNeeded(MAX_PATTERN_TOLERANCE, longestFold), SHORTLIST_RUN_LOOKUPS)
}

export function typoRunsNeeded(tolerance: number, longestFold: number): number {
  return tolerance * (2 + longestFold) + 1
}

export function distinctTypoRunCount(text: TypoText, limit: number): number {
  return distinctTypoRuns(text, limit).length / PATTERN_RUN_CODE_POINTS
}

export function resolvedTypoTolerance(tolerance: PatternTolerance, longestFold: number, distinctRuns: number): number {
  if (tolerance !== 'auto') return tolerance
  for (let candidate = MAX_PATTERN_TOLERANCE; candidate > 0; candidate--) {
    if (distinctRuns >= typoRunsNeeded(candidate, longestFold)) return candidate
  }
  return 0
}
