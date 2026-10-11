import { MATCHER_SIMULATION_BYTES_PER_POSITION } from '../core/pattern-index/constants'
import { hasPosition, type PositionAutomaton } from './automaton'

const LAST_STAMP = 0xffffffff

export class PositionSimulation {
  accepting = false
  private active: Uint32Array
  private following: Uint32Array
  private readonly marks: Uint32Array
  private readonly first: Uint32Array
  private activeCount = 0
  private stamp = 0

  constructor(private readonly automaton: PositionAutomaton) {
    this.active = new Uint32Array(automaton.size)
    this.following = new Uint32Array(automaton.size)
    this.marks = new Uint32Array(automaton.size)
    const first: number[] = []
    for (let position = 0; position < automaton.size; position++) {
      if (hasPosition(automaton.first, position)) first.push(position)
    }
    this.first = Uint32Array.from(first)
  }

  get steps(): number {
    return this.activeCount
  }

  get bytes(): number {
    return this.automaton.size * MATCHER_SIMULATION_BYTES_PER_POSITION
  }

  reset(): void {
    this.active.set(this.first)
    this.activeCount = this.first.length
    this.accepting = this.automaton.nullable
  }

  load(positions: Uint32Array, accepting: boolean): void {
    this.activeCount = 0
    for (let word = 0; word < positions.length; word++) {
      let bits = positions[word]
      while (bits !== 0) {
        this.active[this.activeCount++] = (word << 5) + (31 - Math.clz32(bits & -bits))
        bits &= bits - 1
      }
    }
    this.accepting = accepting
  }

  advance(codePoint: number): void {
    const { automaton, marks } = this
    const following = this.following
    const stamp = this.nextStamp()
    let count = 0
    let accepting = false
    for (let at = 0; at < this.activeCount; at++) {
      const position = this.active[at]
      if (!automaton.accepts(position, codePoint)) continue
      if (hasPosition(automaton.last, position)) accepting = true
      const followers = automaton.followerCount(position)
      for (let index = 0; index < followers; index++) {
        const follower = automaton.follower(position, index)
        if (marks[follower] === stamp) continue
        marks[follower] = stamp
        following[count++] = follower
      }
    }
    if (!automaton.anchoredStart) {
      for (const position of this.first) {
        if (marks[position] === stamp) continue
        marks[position] = stamp
        following[count++] = position
      }
      if (automaton.nullable) accepting = true
    }
    this.following = this.active
    this.active = following
    this.activeCount = count
    this.accepting = accepting
  }

  private nextStamp(): number {
    if (this.stamp === LAST_STAMP) {
      this.marks.fill(0)
      this.stamp = 0
    }
    this.stamp++
    return this.stamp
  }
}
