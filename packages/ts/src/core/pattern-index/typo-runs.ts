import { MAX_PATTERN_TOLERANCE, PATTERN_RUN_CODE_POINTS } from './constants'
import type { PatternHost, PatternTolerance } from './types'

const BASIC_PLANE_LAST = 0xffff

export interface TypoText {
  readonly folded: readonly number[]
  readonly longestFold: number
}

export function isPatternTolerance(value: unknown): value is PatternTolerance {
  if (value === 'auto') return true
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PATTERN_TOLERANCE
}

export function foldTypoText(text: string, host: PatternHost): TypoText {
  const folded: number[] = []
  let longestFold = 0
  for (let at = 0; at < text.length; at++) {
    const codePoint = text.codePointAt(at) ?? 0
    if (codePoint > BASIC_PLANE_LAST) at++
    const before = folded.length
    host.appendFoldedCodePoint(codePoint, folded)
    longestFold = Math.max(longestFold, folded.length - before)
  }
  return { folded, longestFold }
}

export function distinctTypoRuns(text: TypoText, limit: number): number[] {
  const { folded } = text
  const seen = new Set<string>()
  const runs: number[] = []
  for (let at = 0; at + PATTERN_RUN_CODE_POINTS <= folded.length && seen.size < limit; at++) {
    const key = String.fromCodePoint(folded[at], folded[at + 1], folded[at + 2])
    if (seen.has(key)) continue
    seen.add(key)
    runs.push(folded[at], folded[at + 1], folded[at + 2])
  }
  return runs
}

export function typoRunsNeeded(tolerance: number, longestFold: number): number {
  return tolerance * (2 + longestFold) + 1
}

export function distinctTypoRunCount(text: TypoText, limit: number): number {
  return distinctTypoRuns(text, limit).length / PATTERN_RUN_CODE_POINTS
}

export function resolvedTypoTolerance(tolerance: PatternTolerance, text: TypoText): number {
  if (tolerance !== 'auto') return tolerance
  for (let candidate = MAX_PATTERN_TOLERANCE; candidate > 0; candidate--) {
    const needed = typoRunsNeeded(candidate, text.longestFold)
    if (distinctTypoRunCount(text, needed) >= needed) return candidate
  }
  return 0
}
