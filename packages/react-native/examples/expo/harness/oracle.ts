import type { CorpusDocument } from '../src/corpus.ts'

const SCORE_TOLERANCE = 1e-5
const RRF_K = 60

export interface RankedHit {
  id: string
  score: number
}

export interface Finding {
  check: string
  detail: string
}

function byCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftSquares = 0
  let rightSquares = 0
  for (let component = 0; component < left.length; component++) {
    const a = left[component] ?? 0
    const b = right[component] ?? 0
    dot += a * b
    leftSquares += a * a
    rightSquares += b * b
  }
  if (leftSquares === 0 || rightSquares === 0) return 0
  return dot / (Math.sqrt(leftSquares) * Math.sqrt(rightSquares))
}

export function keywordOrder(documents: readonly CorpusDocument[], term: string): string[] {
  const matches: Array<{ id: string; frequency: number }> = []
  for (const document of documents) {
    const frequency = document.title.split(' ').filter(word => word === term).length
    if (frequency > 0) matches.push({ id: document.id, frequency })
  }
  matches.sort((left, right) => right.frequency - left.frequency || byCodePoints(left.id, right.id))
  return matches.map(match => match.id)
}

export function exactNeighbours(documents: readonly CorpusDocument[], query: readonly number[], k: number) {
  return documents
    .map(document => ({ id: document.id, score: cosine(document.embedding, query) }))
    .sort((left, right) => right.score - left.score || byCodePoints(left.id, right.id))
    .slice(0, k)
}

export function checkKeyword(
  documents: readonly CorpusDocument[],
  answers: ReadonlyArray<{ term: string; count?: number; hits: RankedHit[] }>,
  limit: number,
): Finding[] {
  const findings: Finding[] = []
  for (const answer of answers) {
    const expected = keywordOrder(documents, answer.term)
    if (answer.count !== undefined && answer.count !== expected.length) {
      findings.push({ check: `keyword ${answer.term}`, detail: `count ${answer.count}, expected ${expected.length}` })
    }
    const wanted = expected.slice(0, limit)
    const got = answer.hits.map(hit => hit.id)
    const first = wanted.findIndex((id, index) => got[index] !== id)
    if (got.length !== wanted.length || first >= 0) {
      findings.push({
        check: `keyword ${answer.term}`,
        detail: `order differs at rank ${first}: got ${got[first]}, expected ${wanted[first]} (${got.length} hits, expected ${wanted.length})`,
      })
    }
  }
  return findings
}

export function checkVectorScores(
  documents: ReadonlyMap<string, CorpusDocument>,
  query: readonly number[],
  hits: readonly RankedHit[],
  label: string,
): Finding[] {
  const findings: Finding[] = []
  for (const hit of hits) {
    const document = documents.get(hit.id)
    if (document === undefined) {
      findings.push({ check: label, detail: `hit ${hit.id} is no corpus document` })
      continue
    }
    const expected = cosine(document.embedding, query)
    if (!(Math.abs(hit.score - expected) <= SCORE_TOLERANCE)) {
      findings.push({ check: label, detail: `${hit.id} scored ${hit.score}, cosine is ${expected}` })
    }
  }
  return findings
}

export function reciprocalRankOrder(lists: ReadonlyArray<readonly string[]>, k: number = RRF_K): RankedHit[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || byCodePoints(left.id, right.id))
}

export function checkRankedByScore(hits: readonly RankedHit[], label: string): Finding[] {
  const findings: Finding[] = []
  for (let index = 1; index < hits.length; index++) {
    const before = hits[index - 1]
    const hit = hits[index]
    if (before === undefined || hit === undefined) continue
    const outOfOrder = hit.score > before.score || (hit.score === before.score && byCodePoints(before.id, hit.id) > 0)
    if (outOfOrder) {
      findings.push({
        check: label,
        detail: `rank ${index}: ${hit.id} at ${hit.score} follows ${before.id} at ${before.score}`,
      })
    }
  }
  return findings
}

export function checkHybrid(
  documents: readonly CorpusDocument[],
  term: string,
  vectorDepth: readonly RankedHit[],
  hits: readonly RankedHit[],
  depth: number,
  label: string,
): Finding[] {
  const textDepth = keywordOrder(documents, term).slice(0, depth)
  const fused = reciprocalRankOrder([textDepth, vectorDepth.map(hit => hit.id)]).slice(0, depth)
  return checkSameRanking(fused, hits, label)
}

export function recallAt(hits: readonly RankedHit[], exact: ReadonlyArray<{ id: string }>): number {
  const wanted = new Set(exact.map(neighbour => neighbour.id))
  return hits.filter(hit => wanted.has(hit.id)).length / wanted.size
}

export function checkSameRanking(expected: readonly RankedHit[], got: readonly RankedHit[], label: string): Finding[] {
  const findings: Finding[] = []
  if (got.length !== expected.length) {
    findings.push({ check: label, detail: `${got.length} hits, expected ${expected.length}` })
  }
  got.forEach((hit, index) => {
    const wanted = expected[index]
    if (wanted === undefined || wanted.id !== hit.id || Math.abs(wanted.score - hit.score) > SCORE_TOLERANCE) {
      findings.push({
        check: label,
        detail: `rank ${index}: got ${hit.id} at ${hit.score}, expected ${wanted?.id} at ${wanted?.score}`,
      })
    }
  })
  return findings
}
