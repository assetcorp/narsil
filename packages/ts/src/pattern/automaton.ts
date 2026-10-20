export const BEFORE_VALUE_START = 0
export const AFTER_VALUE_END = 0
export const WORD_CODE_POINT = 1
export const OTHER_CODE_POINT = 2

const EDGE_KINDS = 3

export const START_MASK = 0b000_000_111
export const END_MASK = 0b001_001_001
export const WORD_EDGE_MASK = 0b010_101_010
export const ANY_CONTEXT_MASK = 0b111_111_111

export const CONSUME_STATE = 0
export const SPLIT_STATE = 1
export const ASSERT_STATE = 2
export const MATCH_STATE = 3

export const ANY_CODE_POINT = -2
export const TESTED_CODE_POINT = -1

export const MATCH_REACHED = -1

export interface CodePointTest {
  readonly bytes: number
  has(codePoint: number): boolean
}

export interface PatternProgram {
  readonly positions: number
  readonly states: number
  readonly kinds: Uint8Array
  readonly next: Int32Array
  readonly alternative: Int32Array
  readonly masks: Uint16Array
  readonly literals: Int32Array
  readonly tests: ReadonlyArray<CodePointTest | null>
  readonly start: number
  readonly anchoredStart: boolean
  readonly bytes: number
}

export function isWordCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    codePoint === 0x5f
  )
}

export function kindOf(codePoint: number): number {
  return isWordCodePoint(codePoint) ? WORD_CODE_POINT : OTHER_CODE_POINT
}

export function contextOf(previous: number, next: number): number {
  return previous * EDGE_KINDS + next
}

export function accepts(program: PatternProgram, position: number, codePoint: number): boolean {
  const literal = program.literals[position]
  if (literal >= 0) return literal === codePoint
  if (literal === ANY_CODE_POINT) return true
  return program.tests[position]?.has(codePoint) ?? false
}

export interface ClosureScratch {
  readonly marks: Uint32Array
  readonly stack: Int32Array
  stamp: number
}

const LAST_STAMP = 0xffffffff

export function createClosureScratch(states: number): ClosureScratch {
  return { marks: new Uint32Array(states), stack: new Int32Array(states), stamp: 0 }
}

function nextStamp(scratch: ClosureScratch): number {
  if (scratch.stamp === LAST_STAMP) {
    scratch.marks.fill(0)
    scratch.stamp = 0
  }
  scratch.stamp++
  return scratch.stamp
}

export function closeOver(
  program: PatternProgram,
  seeds: Uint32Array,
  seedCount: number,
  fromStart: boolean,
  context: number,
  scratch: ClosureScratch,
  out: Uint32Array,
): number {
  const { kinds, next, alternative, masks } = program
  const { marks, stack } = scratch
  const stamp = nextStamp(scratch)
  let depth = 0
  for (let at = 0; at < seedCount; at++) {
    const state = next[seeds[at]]
    if (marks[state] === stamp) continue
    marks[state] = stamp
    stack[depth++] = state
  }
  if (fromStart && marks[program.start] !== stamp) {
    marks[program.start] = stamp
    stack[depth++] = program.start
  }
  let count = 0
  while (depth > 0) {
    const state = stack[--depth]
    const kind = kinds[state]
    if (kind === CONSUME_STATE) {
      out[count++] = state
      continue
    }
    if (kind === MATCH_STATE) return MATCH_REACHED
    if (kind === ASSERT_STATE && ((masks[state] >>> context) & 1) === 0) continue
    const following = next[state]
    if (marks[following] !== stamp) {
      marks[following] = stamp
      stack[depth++] = following
    }
    if (kind !== SPLIT_STATE) continue
    const other = alternative[state]
    if (marks[other] !== stamp) {
      marks[other] = stamp
      stack[depth++] = other
    }
  }
  return count
}
