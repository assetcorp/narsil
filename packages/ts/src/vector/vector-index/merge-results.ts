import { compareCodePoints } from '../../core/ordering'
import type { VectorScoredResult } from './shared'

export function highScoreFirst(a: VectorScoredResult, b: VectorScoredResult): number {
  return b.score - a.score || compareCodePoints(a.docId, b.docId)
}

export function mergeResults(
  hnswResults: VectorScoredResult[],
  bufferResults: VectorScoredResult[],
  k: number,
): VectorScoredResult[] {
  const seen = new Set<string>()
  const merged: VectorScoredResult[] = []
  let hi = 0
  let bi = 0

  while (merged.length < k && (hi < hnswResults.length || bi < bufferResults.length)) {
    const h = hi < hnswResults.length ? hnswResults[hi] : undefined
    const b = bi < bufferResults.length ? bufferResults[bi] : undefined

    let pick: VectorScoredResult
    if (h && b) {
      if (h.score > b.score || (h.score === b.score && compareCodePoints(h.docId, b.docId) < 0)) {
        pick = h
        hi++
      } else {
        pick = b
        bi++
      }
    } else if (h) {
      pick = h
      hi++
    } else if (b) {
      pick = b
      bi++
    } else {
      break
    }

    if (seen.has(pick.docId)) continue
    seen.add(pick.docId)
    merged.push(pick)
  }

  return merged
}
