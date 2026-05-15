import type { ScoredEntry } from '../transport/types'

export interface DistributedRRFOptions {
  k: number
}

export interface DistributedLinearOptions {
  alpha: number
}

export function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0.5
  if (alpha < 0) return 0
  if (alpha > 1) return 1
  return alpha
}

function compareFusedEntries(a: ScoredEntry, b: ScoredEntry): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  if (a.docId < b.docId) return -1
  if (a.docId > b.docId) return 1
  return 0
}

export function distributedRRF(lists: ScoredEntry[][], options: DistributedRRFOptions): ScoredEntry[] {
  const k = options.k > 0 ? options.k : 60
  const scores = new Map<string, number>()

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const entry = list[rank]
      const rrfContribution = 1 / (k + rank + 1)
      scores.set(entry.docId, (scores.get(entry.docId) ?? 0) + rrfContribution)
    }
  }

  const result: ScoredEntry[] = []
  for (const [docId, score] of scores) {
    result.push({ docId, score, sortValues: null })
  }

  result.sort(compareFusedEntries)
  return result
}

export function distributedLinearCombination(
  textResults: ScoredEntry[],
  vectorResults: ScoredEntry[],
  options: DistributedLinearOptions,
): ScoredEntry[] {
  const { alpha } = options

  const normalizedText = minMaxNormalizeScoredEntries(textResults)
  const normalizedVector = minMaxNormalizeScoredEntries(vectorResults)

  const textScoreMap = new Map<string, number>()
  for (const entry of normalizedText) {
    textScoreMap.set(entry.docId, entry.score)
  }

  const vectorScoreMap = new Map<string, number>()
  for (const entry of normalizedVector) {
    vectorScoreMap.set(entry.docId, entry.score)
  }

  const allDocIds = new Set<string>()
  for (const entry of textResults) allDocIds.add(entry.docId)
  for (const entry of vectorResults) allDocIds.add(entry.docId)

  const result: ScoredEntry[] = []
  for (const docId of allDocIds) {
    const tScore = textScoreMap.get(docId) ?? 0
    const vScore = vectorScoreMap.get(docId) ?? 0
    const combined = alpha * vScore + (1 - alpha) * tScore
    result.push({ docId, score: combined, sortValues: null })
  }

  result.sort(compareFusedEntries)
  return result
}

/**
 * When all scores are identical (range=0), every entry normalizes to 1.0.
 * This can bias linear combination fusion when one modality returns uniform
 * scores, since all its entries receive full weight regardless of relevance.
 */
export function minMaxNormalizeScoredEntries(entries: ScoredEntry[]): Array<{ docId: string; score: number }> {
  if (entries.length === 0) return []

  let min = entries[0].score
  let max = entries[0].score
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].score < min) min = entries[i].score
    if (entries[i].score > max) max = entries[i].score
  }

  const range = max - min
  if (range === 0) {
    return entries.map(e => ({ docId: e.docId, score: 1.0 }))
  }

  return entries.map(e => ({ docId: e.docId, score: (e.score - min) / range }))
}
