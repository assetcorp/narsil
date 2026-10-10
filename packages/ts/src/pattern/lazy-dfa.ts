import { hasPosition, type PositionAutomaton } from './automaton'
import { MATCHER_KEY_CHARACTER_BYTES, MATCHER_STATE_OVERHEAD_BYTES, MATCHER_TRANSITION_BYTES } from './constants'
import type { WorkTally } from './work-tally'

interface DfaState {
  readonly positions: Uint32Array
  readonly steps: number
  readonly accepting: boolean
  readonly next: Map<number, DfaState>
}

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
  private cachedBytes = 0
  private start: DfaState
  private readonly cacheLimitBytes: number

  constructor(
    private readonly automaton: PositionAutomaton,
    stateLimitBytes: number,
  ) {
    this.cacheLimitBytes = stateLimitBytes - automaton.bytes
    this.start = this.intern(automaton.first.slice(), automaton.nullable)
  }

  matches(codePoints: readonly number[], length: number, tally: WorkTally): boolean {
    const { anchoredStart, anchoredEnd, nullable } = this.automaton
    let state = this.start
    if (!anchoredEnd && state.accepting) return true
    for (let at = 0; at < length; at++) {
      if (state.steps === 0) return anchoredStart ? false : nullable
      tally.add(state.steps)
      state = this.step(state, codePoints[at])
      if (!anchoredEnd && state.accepting) return true
    }
    return anchoredEnd && state.accepting
  }

  private step(state: DfaState, codePoint: number): DfaState {
    const cached = state.next.get(codePoint)
    if (cached !== undefined) return cached
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
        automaton.addFollowers(position, positions)
        if (hasPosition(automaton.last, position)) accepting = true
      }
    }
    if (!automaton.anchoredStart) {
      for (let target = 0; target < positions.length; target++) positions[target] |= automaton.first[target]
      if (automaton.nullable) accepting = true
    }
    const next = this.intern(positions, accepting)
    if (this.cachedBytes + MATCHER_TRANSITION_BYTES > this.cacheLimitBytes) return next
    state.next.set(codePoint, next)
    this.cachedBytes += MATCHER_TRANSITION_BYTES
    return next
  }

  private intern(positions: Uint32Array, accepting: boolean): DfaState {
    const key = stateKey(positions, accepting)
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const bytes = stateBytes(positions, key)
    if (this.cachedBytes > 0 && this.cachedBytes + bytes > this.cacheLimitBytes) this.emptyCache()
    const state: DfaState = { positions, steps: countPositions(positions), accepting, next: new Map() }
    this.states.set(key, state)
    this.cachedBytes += bytes
    return state
  }

  private emptyCache(): void {
    this.states = new Map()
    this.cachedBytes = 0
    if (this.start !== undefined) this.start = this.intern(this.start.positions, this.start.accepting)
  }
}
