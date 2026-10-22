import {
  AFTER_VALUE_END,
  ANY_CONTEXT_MASK,
  ASSERT_STATE,
  CONSUME_STATE,
  type CodePointClasses,
  type CodePointTest,
  closeOver,
  codePointClasses,
  contextOf,
  createClosureScratch,
  type FoldTargetCheck,
  MATCH_REACHED,
  MATCH_STATE,
  OTHER_CODE_POINT,
  type PatternProgram,
  SPLIT_STATE,
  WORD_CODE_POINT,
  WORD_KIND_EDGES,
} from '../automaton'
import { PROGRAM_POSITION_BYTES, PROGRAM_STATE_BYTES } from './constants'
import type { Plan } from './lower'

const UNSET = -1

class ProgramBuilder {
  readonly kinds: number[] = []
  readonly next: number[] = []
  readonly alternative: number[] = []
  readonly masks: number[] = []
  readonly literals: number[] = []
  readonly tests: Array<CodePointTest | null> = []
  positions = 0

  add(kind: number, next: number, alternative: number, mask: number): number {
    this.kinds.push(kind)
    this.next.push(next)
    this.alternative.push(alternative)
    this.masks.push(mask)
    this.literals.push(UNSET)
    this.tests.push(null)
    return this.kinds.length - 1
  }

  consume(literal: number, test: CodePointTest | null, next: number): number {
    const state = this.add(CONSUME_STATE, next, UNSET, 0)
    this.literals[state] = literal
    this.tests[state] = test
    this.positions++
    return state
  }

  split(first: number, second: number): number {
    return this.add(SPLIT_STATE, first, second, 0)
  }

  compile(plan: Plan, next: number): number {
    switch (plan.kind) {
      case 'consume':
        return this.consume(plan.literal, plan.test, next)
      case 'assert':
        return plan.mask === ANY_CONTEXT_MASK ? next : this.add(ASSERT_STATE, next, UNSET, plan.mask)
      case 'sequence': {
        let entry = next
        for (let at = plan.items.length - 1; at >= 0; at--) entry = this.compile(plan.items[at], entry)
        return entry
      }
      case 'choice': {
        let entry = this.compile(plan.branches[plan.branches.length - 1], next)
        for (let at = plan.branches.length - 2; at >= 0; at--)
          entry = this.split(this.compile(plan.branches[at], next), entry)
        return entry
      }
      case 'repeat':
        return this.compileRepeat(plan.body, plan.min, plan.max, next)
    }
  }

  private loop(body: Plan, next: number, entersBody: boolean): number {
    const loop = this.split(UNSET, next)
    const entry = this.compile(body, loop)
    this.next[loop] = entry
    return entersBody ? entry : loop
  }

  private compileRepeat(body: Plan, min: number, max: number | null, next: number): number {
    let entry: number
    let required = min
    if (max === null) {
      entry = this.loop(body, next, min > 0)
      if (min > 0) required--
    } else {
      entry = next
      for (let optional = max - min; optional > 0; optional--) entry = this.split(this.compile(body, entry), next)
    }
    for (; required > 0; required--) entry = this.compile(body, entry)
    return entry
  }
}

function startsOnlyAtStart(program: PatternProgram): boolean {
  const scratch = createClosureScratch(program.states)
  const candidates = new Uint32Array(program.positions)
  const seeds = new Uint32Array(0)
  for (const previous of [WORD_CODE_POINT, OTHER_CODE_POINT]) {
    for (const following of [AFTER_VALUE_END, WORD_CODE_POINT, OTHER_CODE_POINT]) {
      const reached = closeOver(program, seeds, 0, true, contextOf(previous, following), scratch, candidates)
      if (reached === MATCH_REACHED || reached > 0) return false
    }
  }
  return true
}

function collectClassEdges(plan: Plan, edges: Set<number>, tests: Set<CodePointTest>): void {
  switch (plan.kind) {
    case 'consume':
      if (plan.literal >= 0) {
        edges.add(plan.literal)
        edges.add(plan.literal + 1)
      } else if (plan.test !== null && !tests.has(plan.test)) {
        tests.add(plan.test)
        const { ranges } = plan.test
        for (let at = 0; at < ranges.length; at += 2) {
          edges.add(ranges[at])
          edges.add(ranges[at + 1] + 1)
        }
      }
      return
    case 'assert':
      return
    case 'sequence':
      for (const item of plan.items) collectClassEdges(item, edges, tests)
      return
    case 'choice':
      for (const branch of plan.branches) collectClassEdges(branch, edges, tests)
      return
    case 'repeat':
      collectClassEdges(plan.body, edges, tests)
  }
}

function planClasses(plan: Plan): CodePointClasses {
  const edges = new Set<number>(WORD_KIND_EDGES)
  const tests = new Set<CodePointTest>()
  collectClassEdges(plan, edges, tests)
  let isFoldTarget: FoldTargetCheck | null = null
  for (const test of tests) isFoldTarget ??= test.isFoldTarget
  return codePointClasses(Uint32Array.from(edges).sort(), isFoldTarget)
}

function programBytes(
  states: number,
  positions: number,
  tests: Iterable<CodePointTest | null>,
  classes: CodePointClasses,
): number {
  const distinct = new Set<CodePointTest>()
  for (const test of tests) if (test !== null) distinct.add(test)
  let bytes =
    states * PROGRAM_STATE_BYTES +
    positions * PROGRAM_POSITION_BYTES +
    classes.starts.byteLength +
    classes.direct.byteLength
  for (const test of distinct) bytes += test.bytes
  return bytes
}

interface PlanSize {
  states: number
  positions: number
}

function sizeOf(plan: Plan, tests: Set<CodePointTest>): PlanSize {
  switch (plan.kind) {
    case 'consume':
      if (plan.test !== null) tests.add(plan.test)
      return { states: 1, positions: 1 }
    case 'assert':
      return { states: plan.mask === ANY_CONTEXT_MASK ? 0 : 1, positions: 0 }
    case 'sequence':
    case 'choice': {
      const children = plan.kind === 'sequence' ? plan.items : plan.branches
      const total: PlanSize = { states: plan.kind === 'choice' ? children.length - 1 : 0, positions: 0 }
      for (const child of children) {
        const size = sizeOf(child, tests)
        total.states += size.states
        total.positions += size.positions
      }
      return total
    }
    case 'repeat': {
      const body = sizeOf(plan.body, tests)
      if (plan.max === null) {
        const copies = Math.max(plan.min, 1)
        return { states: 1 + copies * body.states, positions: copies * body.positions }
      }
      const optional = plan.max - plan.min
      return { states: optional + plan.max * body.states, positions: plan.max * body.positions }
    }
  }
}

export interface ProgramSize {
  readonly states: number
  readonly positions: number
  readonly bytes: number
}

export function planSize(plan: Plan): ProgramSize {
  const tests = new Set<CodePointTest>()
  const size = sizeOf(plan, tests)
  const states = size.states + 1
  return {
    states,
    positions: size.positions,
    bytes: programBytes(states, size.positions, tests, planClasses(plan)),
  }
}

export function compileProgram(plan: Plan): PatternProgram {
  const builder = new ProgramBuilder()
  const match = builder.add(MATCH_STATE, UNSET, UNSET, 0)
  const start = builder.compile(plan, match)
  const count = builder.kinds.length
  const renumbered = new Int32Array(count)
  let nextPosition = 0
  let nextOther = builder.positions
  for (let state = 0; state < count; state++) {
    renumbered[state] = builder.kinds[state] === CONSUME_STATE ? nextPosition++ : nextOther++
  }
  const kinds = new Uint8Array(count)
  const next = new Int32Array(count)
  const alternative = new Int32Array(count)
  const masks = new Uint16Array(count)
  const literals = new Int32Array(builder.positions)
  const tests: Array<CodePointTest | null> = new Array(builder.positions).fill(null)
  for (let state = 0; state < count; state++) {
    const target = renumbered[state]
    kinds[target] = builder.kinds[state]
    next[target] = builder.next[state] === UNSET ? UNSET : renumbered[builder.next[state]]
    alternative[target] = builder.alternative[state] === UNSET ? UNSET : renumbered[builder.alternative[state]]
    masks[target] = builder.masks[state]
    if (target < builder.positions) {
      literals[target] = builder.literals[state]
      tests[target] = builder.tests[state]
    }
  }
  const classes = planClasses(plan)
  const draft: PatternProgram = {
    positions: builder.positions,
    states: count,
    kinds,
    next,
    alternative,
    masks,
    literals,
    tests,
    start: renumbered[start],
    anchoredStart: false,
    classes,
    bytes: programBytes(count, builder.positions, tests, classes),
  }
  return { ...draft, anchoredStart: startsOnlyAtStart(draft) }
}
