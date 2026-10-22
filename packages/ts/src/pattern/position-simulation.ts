import {
  AFTER_VALUE_END,
  accepts,
  BEFORE_VALUE_START,
  type ClosureScratch,
  closeOver,
  contextOf,
  createClosureScratch,
  kindOf,
  MATCH_REACHED,
  type PatternProgram,
} from './automaton'
import { SIMULATION_POSITION_BYTES, SIMULATION_STATE_BYTES } from './constants'

export const STEP_CONTINUES = 0
export const STEP_MATCHED = 1
export const STEP_DEAD = 2

interface StartClosure {
  readonly positions: Uint32Array
  readonly matches: boolean
}

const CONTEXTS = 9

export function simulationBytes(program: Pick<PatternProgram, 'states' | 'positions'>): number {
  const startClosureBytes = CONTEXTS * Uint32Array.BYTES_PER_ELEMENT
  return program.states * SIMULATION_STATE_BYTES + program.positions * (SIMULATION_POSITION_BYTES + startClosureBytes)
}

export class PositionSimulation {
  steps = 0
  previousKind = BEFORE_VALUE_START
  private after: Uint32Array
  private afterCount = 0
  private readonly candidates: Uint32Array
  private readonly scratch: ClosureScratch
  private readonly starts: Array<StartClosure | null> = new Array(CONTEXTS).fill(null)

  constructor(private readonly program: PatternProgram) {
    this.after = new Uint32Array(program.positions)
    this.candidates = new Uint32Array(program.positions)
    this.scratch = createClosureScratch(program.states)
  }

  get bytes(): number {
    return simulationBytes(this.program)
  }

  reset(): void {
    this.afterCount = 0
    this.previousKind = BEFORE_VALUE_START
  }

  load(positions: Uint32Array, previousKind: number): void {
    this.after.set(positions)
    this.afterCount = positions.length
    this.previousKind = previousKind
  }

  sortedAfter(): Uint32Array {
    return this.after.slice(0, this.afterCount).sort()
  }

  step(codePoint: number): number {
    const { program, candidates } = this
    const following = kindOf(codePoint)
    const reached = this.close(contextOf(this.previousKind, following))
    if (reached === MATCH_REACHED) {
      this.steps = 0
      return STEP_MATCHED
    }
    this.steps = reached
    let kept = 0
    for (let at = 0; at < reached; at++) {
      const position = candidates[at]
      if (accepts(program, position, codePoint)) this.after[kept++] = position
    }
    this.afterCount = kept
    this.previousKind = following
    return kept === 0 && program.anchoredStart ? STEP_DEAD : STEP_CONTINUES
  }

  endMatches(): boolean {
    return this.close(contextOf(this.previousKind, AFTER_VALUE_END)) === MATCH_REACHED
  }

  private startClosure(context: number): StartClosure {
    const known = this.starts[context]
    if (known !== null) return known
    const reached = closeOver(this.program, this.after, 0, true, context, this.scratch, this.candidates)
    const closure: StartClosure =
      reached === MATCH_REACHED
        ? { positions: new Uint32Array(0), matches: true }
        : { positions: this.candidates.slice(0, reached), matches: false }
    this.starts[context] = closure
    return closure
  }

  private close(context: number): number {
    const fromStart = this.previousKind === BEFORE_VALUE_START || !this.program.anchoredStart
    const start = fromStart ? this.startClosure(context) : null
    if (start?.matches) return MATCH_REACHED
    const { program, scratch, candidates } = this
    let count = closeOver(program, this.after, this.afterCount, false, context, scratch, candidates)
    if (count === MATCH_REACHED || start === null) return count
    const { marks, stamp } = scratch
    for (const position of start.positions) {
      if (marks[position] === stamp) continue
      marks[position] = stamp
      candidates[count++] = position
    }
    return count
  }
}
