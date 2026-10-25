import type { PartialWordProbe } from './types'

const encoder = new TextEncoder()
const LAST_BASIC_PLANE_CODE_POINT = 0xffff
const BASIC_PLANE_SIZE = 0x10000
const UTF8_CONTINUATION_MASK = 0xc0
const UTF8_CONTINUATION_BITS = 0x80

export function codePointsOf(text: string): number[] {
  const points: number[] = []
  let index = 0
  while (index < text.length) {
    const point = text.codePointAt(index) ?? text.charCodeAt(index)
    points.push(point)
    index += point > LAST_BASIC_PLANE_CODE_POINT ? 2 : 1
  }
  return points
}

export function runKeyAt(points: readonly number[], at: number): string {
  return String.fromCodePoint(points[at], points[at + 1], points[at + 2])
}

export function packedRunKeyAt(points: readonly number[], at: number): number | string {
  const first = points[at]
  const second = points[at + 1]
  const third = points[at + 2]
  if ((first | second | third) > LAST_BASIC_PLANE_CODE_POINT) return String.fromCodePoint(first, second, third)
  return first * BASIC_PLANE_SIZE * BASIC_PLANE_SIZE + second * BASIC_PLANE_SIZE + third
}

export function partialWordProbe(text: string): PartialWordProbe {
  return { text, codePoints: codePointsOf(text), utf8: encoder.encode(text) }
}

export function utf8Contains(haystack: Uint8Array, start: number, end: number, needle: Uint8Array): boolean {
  const last = end - needle.length
  for (let from = start; from <= last; from++) {
    let at = 0
    while (at < needle.length && haystack[from + at] === needle[at]) at++
    if (at === needle.length) return true
  }
  return false
}

export function utf8CodePointCount(bytes: Uint8Array, start: number, end: number): number {
  let count = 0
  for (let at = start; at < end; at++) {
    if ((bytes[at] & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION_BITS) count++
  }
  return count
}
