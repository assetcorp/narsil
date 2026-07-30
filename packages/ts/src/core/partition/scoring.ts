import type { CompactPostingList, ScoredDocument } from '../../types/internal'

export const EMPTY_COMPONENTS: Record<string, number> = Object.freeze({})

export interface ScoreAccumulator {
  score: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

export function accumulateTermScore(
  docScores: Map<number, ScoreAccumulator>,
  internalId: number,
  termScore: number,
  collect: boolean,
  fieldName: string,
  token: string,
  termFrequency: number,
  fieldLength: number,
  idf: number,
): void {
  const existing = docScores.get(internalId)
  if (existing) {
    existing.score += termScore
    if (collect) {
      existing.termFrequencies[`${fieldName}:${token}`] = termFrequency
      existing.fieldLengths[fieldName] = fieldLength
      existing.idf[token] = idf
    }
    return
  }

  if (collect) {
    docScores.set(internalId, {
      score: termScore,
      termFrequencies: { [`${fieldName}:${token}`]: termFrequency },
      fieldLengths: { [fieldName]: fieldLength },
      idf: { [token]: idf },
    })
  } else {
    docScores.set(internalId, {
      score: termScore,
      termFrequencies: EMPTY_COMPONENTS,
      fieldLengths: EMPTY_COMPONENTS,
      idf: EMPTY_COMPONENTS,
    })
  }
}

export interface ResolvedTokenPostings {
  token: string
  matches: Array<{
    token: string
    docFreq: number
    idf: number
    postingList: CompactPostingList
  }>
  totalPostings: number
  isPrefix?: boolean
}

export interface PrefixMatch {
  token: string
  factor: number
  postingList: CompactPostingList
  docFreq: number
  idf: number
}

export interface PrefixContribution {
  score: number
  token: string
  idf: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
}

export function topKFromMap(
  docScores: Map<number, ScoreAccumulator>,
  k: number,
  resolver: { toExternal(id: number): string | undefined },
): ScoredDocument[] {
  if (k <= 0) return []

  const heap: Array<{ internalId: number; score: number }> = []

  for (const [internalId, data] of docScores) {
    if (heap.length < k) {
      heap.push({ internalId, score: data.score })
      if (heap.length === k) buildMinHeap(heap)
    } else if (data.score > heap[0].score) {
      heap[0] = { internalId, score: data.score }
      siftDown(heap, 0)
    }
  }

  heap.sort((a, b) => b.score - a.score)

  const result: ScoredDocument[] = []
  for (let i = 0; i < heap.length; i++) {
    const data = docScores.get(heap[i].internalId)
    if (!data) continue
    const externalId = resolver.toExternal(heap[i].internalId)
    if (externalId === undefined) continue
    result.push({
      docId: externalId,
      score: data.score,
      termFrequencies: data.termFrequencies,
      fieldLengths: data.fieldLengths,
      idf: data.idf,
    })
  }

  return result
}

function buildMinHeap(heap: Array<{ score: number }>): void {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
    siftDown(heap, i)
  }
}

function siftDown(heap: Array<{ score: number }>, idx: number): void {
  const len = heap.length
  while (true) {
    let smallest = idx
    const left = 2 * idx + 1
    const right = 2 * idx + 2
    if (left < len && heap[left].score < heap[smallest].score) smallest = left
    if (right < len && heap[right].score < heap[smallest].score) smallest = right
    if (smallest === idx) break
    const tmp = heap[idx]
    heap[idx] = heap[smallest]
    heap[smallest] = tmp
    idx = smallest
  }
}
