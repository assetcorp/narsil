import { END_MASK, START_MASK } from '../automaton'
import type { PatternNode } from './ast'
import { type Fail, TRAILING_ESCAPE } from './reader'

const BACKSLASH = 0x5c
const STAR = 0x2a
const QUESTION = 0x3f

export function parseWildcard(codePoints: readonly number[], fail: Fail): PatternNode {
  const items: PatternNode[] = [{ kind: 'assert', mask: START_MASK }]
  for (let at = 0; at < codePoints.length; at++) {
    const codePoint = codePoints[at]
    if (codePoint === STAR) {
      items.push({ kind: 'repeat', body: { kind: 'any' }, min: 0, max: null })
    } else if (codePoint === QUESTION) {
      items.push({ kind: 'any' })
    } else if (codePoint === BACKSLASH) {
      if (at + 1 === codePoints.length) fail(TRAILING_ESCAPE, at)
      items.push({ kind: 'literal', codePoint: codePoints[++at] })
    } else {
      items.push({ kind: 'literal', codePoint })
    }
  }
  items.push({ kind: 'assert', mask: END_MASK })
  return { kind: 'sequence', items }
}
