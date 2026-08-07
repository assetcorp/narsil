import { compareCodePoints } from './code-points'
import { multiFoldTable, singleFoldTable } from './fold-table'

interface FoldCursor {
  index: number
  pending: readonly number[] | null
  pendingIndex: number
}

const EXHAUSTED = -1

function nextFoldedCodePoint(
  text: string,
  cursor: FoldCursor,
  single: ReadonlyMap<number, number>,
  multi: ReadonlyMap<number, readonly number[]>,
): number {
  if (cursor.pending !== null) {
    const cp = cursor.pending[cursor.pendingIndex]
    cursor.pendingIndex++
    if (cursor.pendingIndex === cursor.pending.length) {
      cursor.pending = null
      cursor.pendingIndex = 0
    }
    return cp
  }

  if (cursor.index >= text.length) return EXHAUSTED

  let cp = text.charCodeAt(cursor.index)
  cursor.index++
  if (cp < 0x80) {
    return cp >= 0x41 && cp <= 0x5a ? cp + 0x20 : cp
  }
  if (cp >= 0xd800 && cp < 0xdc00 && cursor.index < text.length) {
    const low = text.charCodeAt(cursor.index)
    if (low >= 0xdc00 && low < 0xe000) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00)
      cursor.index++
    }
  }

  const mapped = single.get(cp)
  if (mapped !== undefined) return mapped

  const expansion = multi.get(cp)
  if (expansion === undefined) return cp

  if (expansion.length > 1) {
    cursor.pending = expansion
    cursor.pendingIndex = 1
  }
  return expansion[0]
}

/**
 * Compares the full case folds of two strings in code point order, folding
 * lazily during the comparison, so that it builds no folded copy of either
 * string.
 *
 * Folding maps each code point on its own, so a shared raw prefix folds
 * identically on both sides. The comparison starts at the first differing
 * position.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns A negative number when the fold of `a` orders first, a positive number when the fold of `b` does, and 0 when the folds are equal.
 */
export function compareCaseFolded(a: string, b: string): number {
  const shorter = a.length < b.length ? a.length : b.length
  let start = 0
  while (start < shorter && a.charCodeAt(start) === b.charCodeAt(start)) start++
  if (start === a.length && start === b.length) return 0
  if (start > 0) {
    const previous = a.charCodeAt(start - 1)
    if (previous >= 0xd800 && previous < 0xdc00) start--
  }

  const single = singleFoldTable()
  const multi = multiFoldTable()
  const aCursor: FoldCursor = { index: start, pending: null, pendingIndex: 0 }
  const bCursor: FoldCursor = { index: start, pending: null, pendingIndex: 0 }

  for (;;) {
    const aCp = nextFoldedCodePoint(a, aCursor, single, multi)
    const bCp = nextFoldedCodePoint(b, bCursor, single, multi)
    if (aCp !== bCp) return aCp - bCp
    if (aCp === EXHAUSTED) return 0
  }
}

/**
 * Compares two string sort values as the specification's sort value order
 * defines: by their case folds in code point order, and by their raw code
 * points when the folds are equal. Folding first keeps `Apple` and `apple`
 * adjacent, and the raw comparison keeps them distinct.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns A negative number when `a` sorts first, a positive number when `b` does, and 0 when they are identical.
 */
export function compareSortStrings(a: string, b: string): number {
  const folded = compareCaseFolded(a, b)
  if (folded !== 0) return folded
  return compareCodePoints(a, b)
}
