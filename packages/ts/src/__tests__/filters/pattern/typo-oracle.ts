import { codePointsOf, UNICODE_FOLDS } from './case-folding'

const RUN_CODE_POINTS = 3
const LARGEST_TOLERANCE = 2

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

export function withinTolerance(value: string, text: string, tolerance: number, caseFold: boolean): boolean {
  return editDistance(codePointsOf(value, caseFold), codePointsOf(text, caseFold)) <= tolerance
}
