export interface FuzzyMatch {
  distance: number
  withinTolerance: boolean
}

type Characters = string | readonly string[]

const FIRST_SURROGATE = 0xd800
const LAST_SURROGATE = 0xdfff
const LAST_BASIC_PLANE_CODE_POINT = 0xffff

function hasSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= FIRST_SURROGATE && unit <= LAST_SURROGATE) return true
  }
  return false
}

export function fuzzyPrefixOf(queryTerm: string, prefixLength: number): string {
  let end = 0
  for (let counted = 0; counted < prefixLength && end < queryTerm.length; counted++) {
    const codePoint = queryTerm.codePointAt(end)
    end += codePoint !== undefined && codePoint > LAST_BASIC_PLANE_CODE_POINT ? 2 : 1
  }
  return queryTerm.slice(0, end)
}

export function fuzzyTermMatches(
  queryTerm: string,
  indexTerm: string,
  tolerance: number,
  prefixLength: number,
): boolean {
  if (queryTerm === indexTerm) return true
  if (tolerance <= 0) return false
  if (!indexTerm.startsWith(fuzzyPrefixOf(queryTerm, prefixLength))) return false
  return boundedLevenshtein(queryTerm, indexTerm, tolerance).withinTolerance
}

export function boundedLevenshtein(a: string, b: string, tolerance: number): FuzzyMatch {
  if (tolerance < 0) return { distance: -1, withinTolerance: false }
  if (a === b) return { distance: 0, withinTolerance: true }
  if (hasSurrogate(a) || hasSurrogate(b)) return bandedDistance(Array.from(a), Array.from(b), tolerance)
  return bandedDistance(a, b, tolerance)
}

function bandedDistance(a: Characters, b: Characters, tolerance: number): FuzzyMatch {
  const m = a.length
  const n = b.length
  const beyond = tolerance + 1

  if (Math.abs(m - n) > tolerance) return { distance: beyond, withinTolerance: false }

  let previous = new Uint32Array(n + 1).fill(beyond)
  let current = new Uint32Array(n + 1).fill(beyond)
  const firstRowEnd = Math.min(n, tolerance)
  for (let j = 0; j <= firstRowEnd; j++) previous[j] = j

  for (let i = 1; i <= m; i++) {
    const low = Math.max(1, i - tolerance)
    const high = Math.min(n, i + tolerance)
    current[low - 1] = low === 1 ? i : beyond
    let rowMin = current[low - 1]
    const character = a[i - 1]

    for (let j = low; j <= high; j++) {
      const substitution = previous[j - 1] + (character === b[j - 1] ? 0 : 1)
      const cell = Math.min(previous[j] + 1, current[j - 1] + 1, substitution, beyond)
      current[j] = cell
      if (cell < rowMin) rowMin = cell
    }

    if (rowMin > tolerance) return { distance: beyond, withinTolerance: false }
    const finished = previous
    previous = current
    current = finished
  }

  const distance = previous[n]
  return { distance, withinTolerance: distance <= tolerance }
}
