import type { WorkTally } from './work-tally'

function bordersOf(codePoints: Uint32Array): Uint32Array {
  const length = codePoints.length
  const borders = new Uint32Array(length + 1)
  let border = 0
  for (let at = 1; at < length; at++) {
    while (border > 0 && codePoints[at] !== codePoints[border]) border = borders[border]
    if (codePoints[at] === codePoints[border]) border++
    borders[at + 1] = border
  }
  return borders
}

function reachablePositionsOf(borders: Uint32Array, length: number): Uint32Array {
  const reachable = new Uint32Array(length + 1)
  for (let prefix = 1; prefix <= length; prefix++) {
    reachable[prefix] = (prefix < length ? 1 : 0) + reachable[borders[prefix]]
  }
  return reachable
}

export class LiteralMatcher {
  private readonly borders: Uint32Array
  private readonly reachable: Uint32Array
  private prefix = 0
  private alive = true
  private accepting = false
  private decided: boolean | null = null

  constructor(
    private readonly codePoints: Uint32Array,
    private readonly anchoredStart: boolean,
    private readonly anchoredEnd: boolean,
  ) {
    this.borders = bordersOf(codePoints)
    this.reachable = reachablePositionsOf(this.borders, codePoints.length)
  }

  begin(): boolean {
    this.decided = null
    this.prefix = 0
    this.alive = this.codePoints.length > 0
    this.accepting = this.codePoints.length === 0
    if (!this.anchoredEnd && this.accepting) return this.decide(true)
    return true
  }

  feed(codePoint: number, tally: WorkTally): boolean {
    const steps = this.steps()
    if (steps === 0) return this.decide(!this.anchoredStart && this.codePoints.length === 0)
    tally.add(steps)
    if (this.anchoredStart) this.advanceAnchored(codePoint)
    else this.advance(codePoint)
    if (!this.anchoredEnd && this.accepting) return this.decide(true)
    return true
  }

  matched(): boolean {
    return this.decided ?? (this.anchoredEnd && this.accepting)
  }

  private steps(): number {
    const length = this.codePoints.length
    if (length === 0) return 0
    if (this.anchoredStart) return this.alive && this.prefix < length ? 1 : 0
    return 1 + this.reachable[this.prefix]
  }

  private advanceAnchored(codePoint: number): void {
    if (this.codePoints[this.prefix] === codePoint) {
      this.prefix++
      this.accepting = this.prefix === this.codePoints.length
      return
    }
    this.alive = false
    this.accepting = false
  }

  private advance(codePoint: number): void {
    const { codePoints, borders } = this
    let prefix = this.prefix === codePoints.length ? borders[this.prefix] : this.prefix
    while (prefix > 0 && codePoints[prefix] !== codePoint) prefix = borders[prefix]
    if (codePoints[prefix] === codePoint) prefix++
    this.prefix = prefix
    this.accepting = prefix === codePoints.length
  }

  private decide(outcome: boolean): boolean {
    this.decided = outcome
    return false
  }
}
