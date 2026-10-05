export interface FuzzyMatch {
  distance: number
  withinTolerance: boolean
}

export function fuzzyTermMatches(
  queryTerm: string,
  indexTerm: string,
  tolerance: number,
  prefixLength: number,
): boolean {
  if (queryTerm === indexTerm) return true
  if (tolerance <= 0) return false
  if (prefixLength > 0 && queryTerm.length >= prefixLength && !indexTerm.startsWith(queryTerm.slice(0, prefixLength))) {
    return false
  }
  return boundedLevenshtein(queryTerm, indexTerm, tolerance).withinTolerance
}

export function boundedLevenshtein(a: string, b: string, tolerance: number): FuzzyMatch {
  if (tolerance < 0) return { distance: -1, withinTolerance: false }
  if (a === b) return { distance: 0, withinTolerance: true }

  const m = a.length
  const n = b.length

  const lengthDifference = Math.abs(m - n)

  if (lengthDifference > tolerance) return { distance: tolerance + 1, withinTolerance: false }
  if (a.startsWith(b) || b.startsWith(a)) return { distance: lengthDifference, withinTolerance: true }

  const matrix: number[][] = []
  for (let i = 0; i <= m; i++) {
    matrix[i] = [i]
    for (let j = 1; j <= n; j++) {
      matrix[i][j] = i === 0 ? j : 0
    }
  }

  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + 1)
      }
      rowMin = Math.min(rowMin, matrix[i][j])
    }

    if (rowMin > tolerance) {
      return { distance: tolerance + 1, withinTolerance: false }
    }
  }

  const finalDistance = matrix[m][n]
  return {
    distance: finalDistance,
    withinTolerance: finalDistance <= tolerance,
  }
}
