import { automatonBytes, positionWords } from '../core/pattern-index/matcher-budget'

export interface PositionAutomaton {
  readonly size: number
  readonly words: number
  readonly first: Uint32Array
  readonly last: Uint32Array
  readonly nullable: boolean
  readonly anchoredStart: boolean
  readonly anchoredEnd: boolean
  readonly bytes: number
  accepts(position: number, codePoint: number): boolean
  followerCount(position: number): number
  follower(position: number, index: number): number
}

export function setPosition(words: Uint32Array, position: number): void {
  words[position >>> 5] |= 1 << (position & 31)
}

export function hasPosition(words: Uint32Array, position: number): boolean {
  return (words[position >>> 5] & (1 << (position & 31))) !== 0
}

export function literalAutomaton(
  codePoints: readonly number[],
  anchoredStart: boolean,
  anchoredEnd: boolean,
): PositionAutomaton {
  const size = codePoints.length
  const words = positionWords(size)
  const first = new Uint32Array(words)
  const last = new Uint32Array(words)
  if (size > 0) {
    setPosition(first, 0)
    setPosition(last, size - 1)
  }
  return {
    size,
    words,
    first,
    last,
    nullable: size === 0,
    anchoredStart,
    anchoredEnd,
    bytes: automatonBytes(size),
    accepts: (position, codePoint) => codePoints[position] === codePoint,
    followerCount: position => (position + 1 < size ? 1 : 0),
    follower: position => position + 1,
  }
}
