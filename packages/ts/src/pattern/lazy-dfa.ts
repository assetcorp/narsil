import { hasPosition, type PositionAutomaton, setPosition } from './automaton'
import {
  MATCHER_KEY_CHARACTER_BYTES,
  MATCHER_MIN_CODE_POINTS_PER_STATE,
  MATCHER_STATE_OVERHEAD_BYTES,
  MATCHER_TRANSITION_BYTES,
} from './constants'
import { PositionSimulation } from './position-simulation'
import type { WorkTally } from './work-tally'

interface DfaState {
  readonly positions: Uint32Array
  readonly steps: number
  readonly accepting: boolean
  readonly generation: number
  readonly next: Map<number, DfaState>
}

const UNCACHED_GENERATION = -1

function countPositions(words: Uint32Array): number {
  let count = 0
  for (let word of words) {
    while (word !== 0) {
      word &= word - 1
      count++
    }
  }
  return count
}

function stateKey(positions: Uint32Array, accepting: boolean): string {
  return `${positions.join(',')}${accepting ? '+' : '-'}`
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
  private simulation: PositionSimulation | null = null
  private decided: boolean | null = null
  private readonly cacheLimitBytes: number

  constructor(
    private readonly automaton: PositionAutomaton,
    stateLimitBytes: number,
  ) {
    this.cacheLimitBytes = stateLimitBytes - automaton.bytes
    this.start = this.intern(automaton.first.slice(), automaton.nullable)
    this.state = this.start
    if (this.wantsSimulation()) this.simulate(this.start)
  }

  begin(): boolean {
    this.decided = null
    if (this.simulation !== null) this.simulation.reset()
    else this.state = this.start
    if (!this.automaton.anchoredEnd && this.accepting()) return this.decide(true)
    return true
  }

  feed(codePoint: number, tally: WorkTally): boolean {
    const steps = this.simulation === null ? this.state.steps : this.simulation.steps
    if (steps === 0) return this.decide(!this.automaton.anchoredStart && this.automaton.nullable)
    tally.add(steps)
    if (this.simulation !== null) {
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
    return this.simulation === null ? this.state.accepting : this.simulation.accepting
  }

  private decide(outcome: boolean): boolean {
    this.decided = outcome
    return false
  }

  private wantsSimulation(): boolean {
    return this.simulation === null && this.state.generation === UNCACHED_GENERATION
  }

  private simulate(from: DfaState): void {
    const simulation = new PositionSimulation(this.automaton)
    simulation.load(from.positions, from.accepting)
    this.simulation = simulation
    this.states = new Map()
    this.cachedBytes = 0
  }

  private step(state: DfaState, codePoint: number): DfaState {
    const current = state.generation === this.generation
    if (current) {
      const cached = state.next.get(codePoint)
      if (cached !== undefined) return cached
    }
    const { automaton } = this
    const positions = new Uint32Array(automaton.words)
    let accepting = false
    const source = state.positions
    for (let word = 0; word < source.length; word++) {
      let bits = source[word]
      while (bits !== 0) {
        const position = (word << 5) + (31 - Math.clz32(bits & -bits))
        bits &= bits - 1
        if (!automaton.accepts(position, codePoint)) continue
        const followers = automaton.followerCount(position)
        for (let index = 0; index < followers; index++) setPosition(positions, automaton.follower(position, index))
        if (hasPosition(automaton.last, position)) accepting = true
      }
    }
    if (!automaton.anchoredStart) {
      for (let target = 0; target < positions.length; target++) positions[target] |= automaton.first[target]
      if (automaton.nullable) accepting = true
    }
    const next = this.intern(positions, accepting)
    if (!current || state.generation !== this.generation || next.generation !== this.generation) return next
    if (!this.reserve(MATCHER_TRANSITION_BYTES) || state.generation !== this.generation) return next
    state.next.set(codePoint, next)
    return next
  }

  private intern(positions: Uint32Array, accepting: boolean): DfaState {
    const key = stateKey(positions, accepting)
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const steps = countPositions(positions)
    if (!this.reserve(stateBytes(positions, key))) {
      return { positions, steps, accepting, generation: UNCACHED_GENERATION, next: new Map() }
    }
    const state: DfaState = { positions, steps, accepting, generation: this.generation, next: new Map() }
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
    this.states = new Map()
    this.cachedBytes = 0
    this.codePointsSinceReset = 0
    this.generation++
    this.start = this.intern(this.start.positions, this.start.accepting)
    if (this.start.generation === UNCACHED_GENERATION) return false
    return this.reserve(bytes)
  }
}
