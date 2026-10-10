import { CODE_POINT_BYTES } from './constants'

const WORD_BITS = 32

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
  addFollowers(position: number, into: Uint32Array): void
}

export function wordsFor(size: number): number {
  return Math.max(1, Math.ceil(size / WORD_BITS))
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
  const words = wordsFor(size)
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
    bytes: first.byteLength + last.byteLength + size * CODE_POINT_BYTES,
    accepts: (position, codePoint) => codePoints[position] === codePoint,
    addFollowers: (position, into) => {
      if (position + 1 < size) setPosition(into, position + 1)
    },
  }
}
