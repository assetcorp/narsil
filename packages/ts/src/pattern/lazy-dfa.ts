import { MATCHER_STATE_OVERHEAD_BYTES } from '../core/pattern-index/constants'
import type { PositionAutomaton } from './automaton'
import { MATCHER_KEY_CHARACTER_BYTES, MATCHER_MIN_CODE_POINTS_PER_STATE, MATCHER_TRANSITION_BYTES } from './constants'
import { PositionSimulation } from './position-simulation'
import type { WorkTally } from './work-tally'

interface DfaState {
  readonly active: Uint32Array
  readonly accepting: boolean
  readonly generation: number
  readonly next: Map<number, DfaState>
}

const UNCACHED_GENERATION = -1

function stateKey(active: Uint32Array, accepting: boolean): string {
  return `${active.join(',')}${accepting ? '+' : '-'}`
}

function stateBytes(active: Uint32Array, key: string): number {
  return MATCHER_STATE_OVERHEAD_BYTES + active.byteLength + key.length * MATCHER_KEY_CHARACTER_BYTES
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

  constructor(
    private readonly automaton: PositionAutomaton,
    stateLimitBytes: number,
  ) {
    this.simulation = new PositionSimulation(automaton)
    this.cacheLimitBytes = stateLimitBytes - automaton.bytes - this.simulation.bytes
    this.start = this.intern(this.simulation.firstPositions, automaton.nullable)
    this.state = this.start
    if (this.wantsSimulation()) this.simulate(this.start)
  }

  begin(): boolean {
    this.decided = null
    if (this.simulating) this.simulation.reset()
    else this.state = this.start
    if (!this.automaton.anchoredEnd && this.accepting()) return this.decide(true)
    return true
  }

  feed(codePoint: number, tally: WorkTally): boolean {
    const steps = this.simulating ? this.simulation.steps : this.state.active.length
    if (steps === 0) return this.decide(!this.automaton.anchoredStart && this.automaton.nullable)
    tally.add(steps)
    if (this.simulating) {
      this.simulation.advance(codePoint)
    } else {
      this.codePointsSinceReset++
      this.state = this.step(this.state, codePoint)
      if (this.wantsSimulation()) this.simulate(this.state)
    }
    if (!this.automaton.anchoredEnd && this.accepting()) return this.decide(true)
    return true
  }

  matched(): boolean {
    return this.decided ?? (this.automaton.anchoredEnd && this.accepting())
  }

  private accepting(): boolean {
    return this.simulating ? this.simulation.accepting : this.state.accepting
  }

  private decide(outcome: boolean): boolean {
    this.decided = outcome
    return false
  }

  private wantsSimulation(): boolean {
    return !this.simulating && this.state.generation === UNCACHED_GENERATION
  }

  private simulate(from: DfaState): void {
    this.dropCache()
    this.state = this.start
    this.simulation.load(from.active, from.accepting)
    this.simulating = true
  }

  private dropCache(): void {
    for (const state of this.states.values()) state.next.clear()
    this.start.next.clear()
    this.state.next.clear()
    this.states = new Map()
    this.cachedBytes = 0
  }

  private step(state: DfaState, codePoint: number): DfaState {
    const current = state.generation === this.generation
    if (current) {
      const cached = state.next.get(codePoint)
      if (cached !== undefined) return cached
    }
    const { simulation } = this
    simulation.load(state.active, state.accepting)
    simulation.advance(codePoint)
    const next = this.intern(simulation.sortedActive(), simulation.accepting)
    if (!current || state.generation !== this.generation || next.generation !== this.generation) return next
    if (!this.reserve(MATCHER_TRANSITION_BYTES) || state.generation !== this.generation) return next
    state.next.set(codePoint, next)
    return next
  }

  private intern(active: Uint32Array, accepting: boolean): DfaState {
    const key = stateKey(active, accepting)
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    if (!this.reserve(stateBytes(active, key))) {
      return { active, accepting, generation: UNCACHED_GENERATION, next: new Map() }
    }
    const state: DfaState = { active, accepting, generation: this.generation, next: new Map() }
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
    this.dropCache()
    this.codePointsSinceReset = 0
    this.generation++
    this.start = this.intern(this.start.active, this.start.accepting)
    if (this.start.generation === UNCACHED_GENERATION) return false
    return this.reserve(bytes)
  }
}
