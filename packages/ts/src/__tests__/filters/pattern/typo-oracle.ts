import { codePointsOf, UNICODE_FOLDS } from './case-folding'

const RUN_CODE_POINTS = 3
const LARGEST_TOLERANCE = 2
const CACHED_TEXTS = 20_000

const cachedPoints = [new Map<string, number[]>(), new Map<string, number[]>()]

function pointsOf(text: string, caseFold: boolean): number[] {
  const cache = cachedPoints[caseFold ? 1 : 0]
  const known = cache.get(text)
  if (known !== undefined) return known
  if (cache.size >= CACHED_TEXTS) cache.clear()
  const points = codePointsOf(text, caseFold)
  cache.set(text, points)
  return points
}

export const TYPO_TEXTS = [
  'INV-2O24-001',
  'inv-2024-00',
  'INV-2024-0011',
  'INV-2O24',
  'Strasse',
  'Straßen',
  'STRASE',
  'σίσυφοσ',
  'ΣΊΣΥΦΟ',
  'Istanbul',
  'İstanbol',
  'conection refused',
  'Connection refused at 10.0.0.2',
  'abcabd',
  'aaaaaaa',
  'ﬃxxx',
  'cafe',
  'café',
  '😀 smile 😁',
  'Error: disk ful',
  'FUSS BAL',
  'resume',
  'betaa',
  'gamm',
  'warnings',
]

export function editDistance(left: readonly number[], right: readonly number[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, column) => column)
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution))
    }
    previous = current
  }
  return previous[right.length]
}

export function distinctRuns(text: string): number {
  const folded = codePointsOf(text, true)
  const runs = new Set<string>()
  for (let at = 0; at + RUN_CODE_POINTS <= folded.length; at++) {
    runs.add(folded.slice(at, at + RUN_CODE_POINTS).join(','))
  }
  return runs.size
}

function longestFold(text: string): number {
  let longest = 0
  for (const character of text) {
    const fold = UNICODE_FOLDS.get(character.codePointAt(0) ?? 0)
    longest = Math.max(longest, fold === undefined ? 1 : fold.length)
  }
  return longest
}

export function runsNeeded(text: string, tolerance: number): number {
  return tolerance * (2 + longestFold(text)) + 1
}

export function acceptedTolerance(text: string, tolerance: unknown): number | null {
  if (tolerance === 0) return 0
  if (tolerance === 'auto') {
    for (let candidate = LARGEST_TOLERANCE; candidate > 0; candidate--) {
      if (runsNeeded(text, candidate) <= distinctRuns(text)) return candidate
    }
    return 0
  }
  if (tolerance !== 1 && tolerance !== 2) return null
  return runsNeeded(text, tolerance) <= distinctRuns(text) ? tolerance : null
}

function distanceWithin(left: readonly number[], right: readonly number[], bound: number): boolean {
  if (Math.abs(left.length - right.length) > bound) return false
  const beyond = bound + 1
  let previous = new Int32Array(right.length + 1).fill(beyond)
  let current = new Int32Array(right.length + 1)
  for (let column = 0; column <= Math.min(right.length, bound); column++) previous[column] = column
  for (let row = 1; row <= left.length; row++) {
    current.fill(beyond)
    if (row <= bound) current[0] = row
    let rowLeast = current[0]
    for (let column = Math.max(1, row - bound); column <= Math.min(right.length, row + bound); column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution, beyond)
      rowLeast = Math.min(rowLeast, current[column])
    }
    if (rowLeast > bound) return false
    ;[previous, current] = [current, previous]
  }
  return previous[right.length] <= bound
}

export function withinTolerance(value: string, text: string, tolerance: number, caseFold: boolean): boolean {
  return distanceWithin(pointsOf(value, caseFold), pointsOf(text, caseFold), tolerance)
}
