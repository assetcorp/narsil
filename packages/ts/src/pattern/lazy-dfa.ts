import { MATCHER_STATE_OVERHEAD_BYTES } from '../core/pattern-index/constants'
import { BEFORE_VALUE_START, classOf, type PatternProgram } from './automaton'
import {
  MATCHER_EDGE_SLOT_BYTES,
  MATCHER_KEY_CHARACTER_BYTES,
  MATCHER_MIN_CODE_POINTS_PER_STATE,
  MATCHER_TRANSITION_BYTES,
  MAX_DENSE_EDGE_CLASSES,
} from './constants'
import { PositionSimulation, STEP_DEAD, STEP_MATCHED } from './position-simulation'
import type { WorkTally } from './work-tally'

interface DfaState {
  readonly positions: Uint32Array
  readonly previousKind: number
  readonly generation: number
  denseEdges: Array<DfaEdge | undefined> | null
  sparseEdges: Map<number, DfaEdge> | null
  endMatch: boolean | null
}

interface DfaEdge {
  readonly target: DfaState
  readonly steps: number
}

const UNCACHED_GENERATION = -1
const DECIDED_GENERATION = -2

function decidedState(): DfaState {
  return {
    positions: new Uint32Array(0),
    previousKind: BEFORE_VALUE_START,
    generation: DECIDED_GENERATION,
    denseEdges: null,
    sparseEdges: null,
    endMatch: null,
  }
}

function clearEdges(state: DfaState): void {
  state.denseEdges = null
  state.sparseEdges = null
}

const MATCHED = decidedState()
const DEAD = decidedState()

function stateKey(positions: Uint32Array, previousKind: number): string {
  return `${previousKind}:${positions.join(',')}`
}

function stateBytes(positions: Uint32Array, key: string): number {
  return MATCHER_STATE_OVERHEAD_BYTES + positions.byteLength + key.length * MATCHER_KEY_CHARACTER_BYTES
}

export class LazyDfa {
  private states = new Map<string, DfaState>()
  private generation = 0
  private cachedBytes = 0
  private codePointsSinceReset = 0
  private start: DfaState
  private state: DfaState
  private simulating = false
  private decided: boolean | null = null
  private readonly simulation: PositionSimulation
  private readonly cacheLimitBytes: number
  private readonly directClasses: Int32Array
  private readonly denseClasses: number

  constructor(
    private readonly program: PatternProgram,
    stateLimitBytes: number,
  ) {
    this.directClasses = program.classes.direct
    const classCount = program.classes.starts.length + 1
    this.denseClasses = classCount <= MAX_DENSE_EDGE_CLASSES ? classCount : 0
    this.simulation = new PositionSimulation(program)
    this.cacheLimitBytes = stateLimitBytes - program.bytes - this.simulation.bytes
    this.start = this.intern(new Uint32Array(0), BEFORE_VALUE_START)
    this.state = this.start
    if (this.wantsSimulation()) this.simulate(this.start)
  }

  get heldBytes(): number {
    return this.program.bytes + this.simulation.bytes + this.cachedBytes
  }

  begin(): boolean {
    this.decided = null
    this.simulating = false
    this.state = this.start
    if (this.wantsSimulation()) this.simulate(this.start)
    return true
  }

  feed(codePoint: number, tally: WorkTally): boolean {
    if (this.simulating) {
      const outcome = this.simulation.step(codePoint)
      tally.add(this.simulation.steps)
      if (outcome === STEP_MATCHED) return this.decide(true)
      if (outcome === STEP_DEAD) return this.decide(false)
      return true
    }
    this.codePointsSinceReset++
    const direct = this.directClasses
    const codePointClass = codePoint < direct.length ? direct[codePoint] : classOf(this.program, codePoint)
    const edge = this.edge(this.state, codePoint, codePointClass)
    tally.add(edge.steps)
    if (edge.target === MATCHED) return this.decide(true)
    if (edge.target === DEAD) return this.decide(false)
    this.state = edge.target
    if (this.wantsSimulation()) this.simulate(this.state)
    return true
  }

  matched(): boolean {
    if (this.decided !== null) return this.decided
    if (this.simulating) return this.simulation.endMatches()
    const { state } = this
    if (state.endMatch === null) {
      this.simulation.load(state.positions, state.previousKind)
      state.endMatch = this.simulation.endMatches()
    }
    return state.endMatch
  }

  private decide(outcome: boolean): boolean {
    this.decided = outcome
    return false
  }

  private wantsSimulation(): boolean {
    return !this.simulating && this.state.generation === UNCACHED_GENERATION
  }

  private simulate(from: DfaState): void {
    this.restartCache()
    this.state = this.start
    this.simulation.load(from.positions, from.previousKind)
    this.simulating = true
  }

  private restartCache(): void {
    this.dropCache()
    this.codePointsSinceReset = 0
    this.generation++
    this.start = this.intern(this.start.positions, this.start.previousKind)
  }

  private dropCache(): void {
    for (const state of this.states.values()) clearEdges(state)
    clearEdges(this.start)
    clearEdges(this.state)
    this.states = new Map()
    this.cachedBytes = 0
  }

  private edge(state: DfaState, codePoint: number, codePointClass: number): DfaEdge {
    const current = state.generation === this.generation
    const dense = codePointClass >= 0 && codePointClass < this.denseClasses
    if (current) {
      const cached = dense ? state.denseEdges?.[codePointClass] : state.sparseEdges?.get(codePointClass)
      if (cached !== undefined) return cached
    }
    const { simulation } = this
    simulation.load(state.positions, state.previousKind)
    const outcome = simulation.step(codePoint)
    const steps = simulation.steps
    let target = MATCHED
    if (outcome === STEP_DEAD) target = DEAD
    else if (outcome !== STEP_MATCHED) target = this.intern(simulation.sortedAfter(), simulation.previousKind)
    const edge: DfaEdge = { target, steps }
    const targetCached = target.generation === DECIDED_GENERATION || target.generation === this.generation
    if (!current || state.generation !== this.generation || !targetCached) return edge
    if (!this.reserve(MATCHER_TRANSITION_BYTES) || state.generation !== this.generation) return edge
    if (!dense) {
      state.sparseEdges ??= new Map()
      state.sparseEdges.set(codePointClass, edge)
      return edge
    }
    if (state.denseEdges === null) {
      const slotBytes = this.denseClasses * MATCHER_EDGE_SLOT_BYTES
      if (!this.reserve(slotBytes) || state.generation !== this.generation) return edge
      state.denseEdges = new Array<DfaEdge | undefined>(this.denseClasses).fill(undefined)
    }
    state.denseEdges[codePointClass] = edge
    return edge
  }

  private intern(positions: Uint32Array, previousKind: number): DfaState {
    const key = stateKey(positions, previousKind)
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const fresh = (generation: number): DfaState => ({
      positions,
      previousKind,
      generation,
      denseEdges: null,
      sparseEdges: null,
      endMatch: null,
    })
    if (!this.reserve(stateBytes(positions, key))) return fresh(UNCACHED_GENERATION)
    const state = fresh(this.generation)
    this.states.set(key, state)
    return state
  }

  private reserve(bytes: number): boolean {
    if (this.cachedBytes + bytes <= this.cacheLimitBytes) {
      this.cachedBytes += bytes
      return true
    }
    if (this.states.size === 0 || this.codePointsSinceReset < MATCHER_MIN_CODE_POINTS_PER_STATE * this.states.size) {
      return false
    }
    this.restartCache()
    if (this.start.generation === UNCACHED_GENERATION) return false
    return this.reserve(bytes)
  }
}
