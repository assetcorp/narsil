export function encodeScore(score: number): number | 'NaN' | 'Infinity' | '-Infinity' {
  if (Number.isFinite(score)) return score
  if (Number.isNaN(score)) return 'NaN'
  return score > 0 ? 'Infinity' : '-Infinity'
}

export function decodeScore(score: unknown): number | undefined {
  if (typeof score === 'number') return Number.isFinite(score) ? score : undefined
  if (score === 'NaN') return Number.NaN
  if (score === 'Infinity') return Number.POSITIVE_INFINITY
  if (score === '-Infinity') return Number.NEGATIVE_INFINITY
  return undefined
}
