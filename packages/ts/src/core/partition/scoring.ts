import type { CompactPostingList, ScoredDocument } from '../../types/internal'
import { compareCodePoints } from '../ordering'

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

interface TopKCandidate {
  internalId: number
  externalId: string
  score: number
}

function candidateWorse(a: TopKCandidate, b: TopKCandidate): boolean {
  if (a.score !== b.score) return a.score < b.score
  return compareCodePoints(a.externalId, b.externalId) > 0
}

export function topKFromMap(
  docScores: Map<number, ScoreAccumulator>,
  k: number,
  resolver: { toExternal(id: number): string | undefined },
): ScoredDocument[] {
  if (k <= 0) return []

  const heap: TopKCandidate[] = []

  for (const [internalId, data] of docScores) {
    const externalId = resolver.toExternal(internalId)
    if (externalId === undefined) continue
    const candidate = { internalId, externalId, score: data.score }
    if (heap.length < k) {
      heap.push(candidate)
      if (heap.length === k) buildMinHeap(heap)
    } else if (candidateWorse(heap[0], candidate)) {
      heap[0] = candidate
      siftDown(heap, 0)
    }
  }

  heap.sort((a, b) => b.score - a.score || compareCodePoints(a.externalId, b.externalId))

  const result: ScoredDocument[] = []
  for (let i = 0; i < heap.length; i++) {
    const data = docScores.get(heap[i].internalId)
    if (!data) continue
    result.push({
      docId: heap[i].externalId,
      score: data.score,
      termFrequencies: data.termFrequencies,
      fieldLengths: data.fieldLengths,
      idf: data.idf,
    })
  }

  return result
}

function buildMinHeap(heap: TopKCandidate[]): void {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
    siftDown(heap, i)
  }
}

function siftDown(heap: TopKCandidate[], idx: number): void {
  const len = heap.length
  while (true) {
    let worst = idx
    const left = 2 * idx + 1
    const right = 2 * idx + 2
    if (left < len && candidateWorse(heap[left], heap[worst])) worst = left
    if (right < len && candidateWorse(heap[right], heap[worst])) worst = right
    if (worst === idx) break
    const tmp = heap[idx]
    heap[idx] = heap[worst]
    heap[worst] = tmp
    idx = worst
  }
}
