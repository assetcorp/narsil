import type { RerankAdapter } from '../../types/adapters'

export interface RankedHit {
  id: string
  score: number
}

export interface RecordedCall {
  query: string
  documents: string[]
}

export interface RecordingReranker extends RerankAdapter {
  calls: RecordedCall[]
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export function overlapScore(query: string, document: string): number {
  const wanted = new Set(wordsOf(query))
  let score = 0
  for (const word of wordsOf(document)) {
    if (wanted.has(word)) score += 1
  }
  return score / (1 + wordsOf(document).length / 100)
}

export function recordingReranker(
  score: (query: string, document: string) => number = overlapScore,
): RecordingReranker {
  const calls: RecordedCall[] = []
  return {
    calls,
    async rerank(query, documents) {
      calls.push({ query, documents: [...documents] })
      return documents.map(document => score(query, document))
    },
  }
}

export function compareCodePointOrder(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const shared = Math.min(left.length, right.length)
  for (let i = 0; i < shared; i++) {
    const difference = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function valueAt(document: Record<string, unknown>, path: string): unknown {
  let current: unknown = document
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function rerankTextOf(document: Record<string, unknown> | undefined, fields: string[]): string {
  if (document === undefined) return ''
  const lines: string[] = []
  for (const field of fields) {
    const value = valueAt(document, field)
    if (typeof value === 'string') lines.push(value)
    else if (Array.isArray(value)) {
      for (const member of value) if (typeof member === 'string') lines.push(member)
    }
  }
  return lines.join('\n')
}

export function oracleRerank(firstStage: RankedHit[], window: number, scores: number[]): RankedHit[] {
  const reach = Math.min(window, firstStage.length)
  const head = firstStage.slice(0, reach)
  if (scores.length !== head.length) throw new Error(`oracle needs ${head.length} scores, got ${scores.length}`)
  const reranked = head
    .map((hit, i) => ({ id: hit.id, score: scores[i] }))
    .sort((a, b) => b.score - a.score || compareCodePointOrder(a.id, b.id))
  const tail = firstStage.slice(reach).map(hit => ({ ...hit }))
  if (head.length > 0 && tail.length > 0) {
    const initialLow = Math.min(...head.map(hit => hit.score))
    const initialHigh = Math.max(...head.map(hit => hit.score))
    const finalLow = Math.min(...scores)
    const finalHigh = Math.max(...scores)
    if (initialLow > finalLow) {
      const scale = Math.max(finalHigh - finalLow, 1) / Math.max(initialHigh - initialLow, 1)
      const bias = finalLow - initialLow * scale
      for (const hit of tail) hit.score = hit.score * scale + bias
    }
  }
  return [...reranked, ...tail]
}

export function oraclePage(ordered: RankedHit[], offset: number, limit: number, depth = 0): RankedHit[] {
  return ordered.slice(depth + offset, depth + offset + limit)
}

export function cosineOf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    left += a[i] * a[i]
    right += b[i] * b[i]
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right)
}

export function oracleRrf(lists: RankedHit[][], k = 60): RankedHit[] {
  const fused = new Map<string, number>()
  for (const list of lists) {
    for (const [rank, hit] of list.entries()) fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (k + rank + 1))
  }
  return [...fused]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || compareCodePointOrder(a.id, b.id))
}
