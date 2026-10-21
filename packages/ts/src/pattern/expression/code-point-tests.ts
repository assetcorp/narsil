import type { PatternHost } from '../../core/pattern-index/types'
import type { CodePointTest } from '../automaton'
import type { ClassName, SetItem } from './ast'
import { CODE_POINT_TEST_ENTRY_BYTES } from './constants'

const CLASS_RANGES: Readonly<Record<ClassName, readonly number[]>> = {
  digit: [0x30, 0x39],
  word: [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a],
  space: [0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x20],
}

function mergedRanges(bounds: number[]): Uint32Array {
  const pairs: Array<[number, number]> = []
  for (let at = 0; at < bounds.length; at += 2) pairs.push([bounds[at], bounds[at + 1]])
  pairs.sort((left, right) => left[0] - right[0])
  const merged: number[] = []
  for (const [low, high] of pairs) {
    const last = merged.length - 1
    if (merged.length > 0 && low <= merged[last] + 1) merged[last] = Math.max(merged[last], high)
    else merged.push(low, high)
  }
  return Uint32Array.from(merged)
}

function inRanges(ranges: Uint32Array, codePoint: number): boolean {
  let low = 0
  let high = ranges.length / 2
  while (low < high) {
    const middle = (low + high) >>> 1
    if (codePoint < ranges[middle * 2]) high = middle
    else if (codePoint > ranges[middle * 2 + 1]) low = middle + 1
    else return true
  }
  return false
}

function rangeBoundsOf(items: readonly SetItem[]): number[] {
  const bounds: number[] = []
  for (const item of items) {
    if (item.kind === 'member') bounds.push(item.codePoint, item.codePoint)
    else if (item.kind === 'range') bounds.push(item.low, item.high)
    else bounds.push(...CLASS_RANGES[item.name])
  }
  return bounds
}

function rangeTest(ranges: Uint32Array, negated: boolean): CodePointTest {
  return {
    bytes: ranges.byteLength + CODE_POINT_TEST_ENTRY_BYTES,
    ranges,
    isFoldTarget: null,
    has: codePoint => inRanges(ranges, codePoint) !== negated,
  }
}

function foldedRangeTest(ranges: Uint32Array, negated: boolean, host: PatternHost): CodePointTest {
  const holdsFold = (folded: number): boolean => {
    if (inRanges(ranges, folded)) return true
    for (const source of host.singleFoldSources(folded)) if (inRanges(ranges, source)) return true
    return false
  }
  return {
    bytes: ranges.byteLength + CODE_POINT_TEST_ENTRY_BYTES,
    ranges,
    isFoldTarget: folded => host.singleFoldSources(folded).length > 0,
    has: folded => holdsFold(folded) !== negated,
  }
}

export function classTest(name: ClassName): CodePointTest {
  return rangeTest(mergedRanges([...CLASS_RANGES[name]]), false)
}

export function setTest(
  items: readonly SetItem[],
  negated: boolean,
  caseFold: boolean,
  host: PatternHost,
): CodePointTest {
  const ranges = mergedRanges(rangeBoundsOf(items))
  return caseFold ? foldedRangeTest(ranges, negated, host) : rangeTest(ranges, negated)
}

export function distinctMultiFolds(items: readonly SetItem[], host: PatternHost): number[][] {
  const seen = new Set<string>()
  const folds: number[][] = []
  for (const item of items) {
    if (item.kind !== 'member') continue
    const fold: number[] = []
    host.appendFoldedCodePoint(item.codePoint, fold)
    if (fold.length < 2) continue
    const key = String.fromCodePoint(...fold)
    if (seen.has(key)) continue
    seen.add(key)
    folds.push(fold)
  }
  return folds
}
