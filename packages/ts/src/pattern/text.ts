import { PATTERN_RUN_CODE_POINTS } from '../core/pattern-index/constants'
import type { PatternHost } from '../core/pattern-index/types'

const BASIC_PLANE_LAST = 0xffff

export function appendCodePoints(text: string, out: number[]): void {
  for (let at = 0; at < text.length; at++) {
    const codePoint = text.codePointAt(at) ?? 0
    out.push(codePoint)
    if (codePoint > BASIC_PLANE_LAST) at++
  }
}

export function appendTextCodePoints(text: string, caseFold: boolean, host: PatternHost, out: number[]): void {
  if (caseFold) {
    host.appendFolded(text, out)
  } else {
    appendCodePoints(text, out)
  }
}

export function runKey(first: number, second: number, third: number): string {
  return String.fromCodePoint(first, second, third)
}

export function runKeyCodePoints(key: string, out: Uint32Array, offset: number): void {
  let slot = offset
  for (let at = 0; at < key.length && slot < offset + PATTERN_RUN_CODE_POINTS; at++) {
    const codePoint = key.codePointAt(at) ?? 0
    out[slot++] = codePoint
    if (codePoint > BASIC_PLANE_LAST) at++
  }
}

export function compareRuns(left: Uint32Array, leftAt: number, right: Uint32Array, rightAt: number): number {
  for (let offset = 0; offset < PATTERN_RUN_CODE_POINTS; offset++) {
    const difference = left[leftAt + offset] - right[rightAt + offset]
    if (difference !== 0) return difference
  }
  return 0
}

export function collectRunKeys(foldedCodePoints: readonly number[], out: Set<string>): void {
  for (let at = 0; at + PATTERN_RUN_CODE_POINTS <= foldedCodePoints.length; at++) {
    out.add(runKey(foldedCodePoints[at], foldedCodePoints[at + 1], foldedCodePoints[at + 2]))
  }
}

export function forEachTextValue(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (!Array.isArray(value)) return
  for (const element of value) {
    if (typeof element === 'string') visit(element)
  }
}

export function holdsTextValue(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value)
}
