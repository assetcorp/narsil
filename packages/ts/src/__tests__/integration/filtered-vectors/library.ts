import { expect } from 'vitest'
import type { FilterExpression } from '../../../types/filters'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'

export const DIMENSION = 24
export const K = 10
export const SHELVES = 50
const CENTRES = 16
const SPREAD = 0.6
const QUERY_COUNT = 20
const RECALL_FLOOR = 0.95
const SCORE_TOLERANCE = 1e-4
const PROMOTION_THRESHOLD = 100
const MAX_CONCURRENT_PASSES = 50
const CONCURRENT_DEADLINE_MS = 120_000

export const INDEX = 'shelves'

export const shelvesConfig: IndexConfig = {
  schema: { shelf: 'number', embedding: `vector[${DIMENSION}]` },
  vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization: 'none' },
}

export type ShelvedPaper = AnyDocument & {
  id: string
  shelf: number
  embedding: number[]
}

export type Library = Map<string, ShelvedPaper>

export interface Hit {
  id: string
  score: number
}

export type Ask = (query: number[], filters: FilterExpression) => Promise<Hit[]>

interface Selectivity {
  share: string
  filters: FilterExpression
  passes: (shelf: number) => boolean
}

export const selectivities: Selectivity[] = [
  { share: '2%', filters: { fields: { shelf: { eq: 0 } } }, passes: shelf => shelf === 0 },
  { share: '30%', filters: { fields: { shelf: { lt: 15 } } }, passes: shelf => shelf < 15 },
]

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const random = seededRandom(20261028)
const centres = Array.from({ length: CENTRES }, () => Array.from({ length: DIMENSION }, () => random() * 2 - 1))

export function nearCentre(): number[] {
  const centre = centres[Math.floor(random() * CENTRES)]
  return centre.map(value => Math.fround(value + (random() - 0.5) * SPREAD))
}

export function randomShelf(): number {
  return Math.floor(random() * SHELVES)
}

export const queries = Array.from({ length: QUERY_COUNT }, nearCentre)

export function papersFrom(start: number, count: number): ShelvedPaper[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `paper-${String(start + i).padStart(5, '0')}`,
    shelf: randomShelf(),
    embedding: nearCentre(),
  }))
}

export function vectorQuery(query: number[], filters: FilterExpression): QueryParams {
  return { mode: 'vector', limit: K, filters, document: false, vector: { field: 'embedding', value: query } }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let aSquared = 0
  let bSquared = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aSquared += a[i] * a[i]
    bSquared += b[i] * b[i]
  }
  return dot / Math.sqrt(aSquared * bSquared)
}

function nearestMatching(library: Library, query: number[], passes: (shelf: number) => boolean): string[] {
  return [...library.values()]
    .filter(paper => passes(paper.shelf))
    .map(paper => ({ id: paper.id, score: cosine(query, paper.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
    .map(entry => entry.id)
}

export function problemWith(
  library: Library,
  query: number[],
  passes: (shelf: number) => boolean,
  hits: readonly Hit[],
): string | null {
  const truth = nearestMatching(library, query, passes)
  if (hits.length !== truth.length) return `${hits.length} hits where ${truth.length} documents match`
  for (const hit of hits) {
    const paper = library.get(hit.id)
    if (paper === undefined) return `${hit.id} is absent from the index`
    if (!passes(paper.shelf)) return `${hit.id} sits on shelf ${paper.shelf}, which the filter excludes`
    const expected = cosine(query, paper.embedding)
    if (Math.abs(hit.score - expected) > SCORE_TOLERANCE) {
      return `${hit.id} scored ${hit.score} where its current vector scores ${expected}`
    }
  }
  return null
}

export function recallAt(library: Library, query: number[], passes: (shelf: number) => boolean, hits: Hit[]): number {
  const truth = new Set(nearestMatching(library, query, passes))
  return hits.filter(hit => truth.has(hit.id)).length
}

export async function expectFilteredAnswers(ask: Ask, library: Library, stage: string): Promise<void> {
  for (const { share, filters, passes } of selectivities) {
    let found = 0
    let wanted = 0
    for (const query of queries) {
      const hits = await ask(query, filters)
      expect(problemWith(library, query, passes, hits), `${stage} at ${share}`).toBeNull()
      found += recallAt(library, query, passes, hits)
      wanted += nearestMatching(library, query, passes).length
    }
    expect(wanted === 0 ? 1 : found / wanted, `recall@${K} ${stage} at ${share}`).toBeGreaterThanOrEqual(RECALL_FLOOR)
  }
}

export type Answer = { hits: Hit[] } | { refusedWith: string }

export type AskDuringChange = (query: number[], filters: FilterExpression) => Promise<Answer>

export interface ConcurrentAnswers {
  complete: number
  partial: number
  refused: number
}

function unsoundHit(
  libraries: readonly Library[],
  query: number[],
  passes: (shelf: number) => boolean,
  hits: readonly Hit[],
): string | null {
  if (hits.length > K) return `${hits.length} hits where the limit is ${K}`
  const seen = new Set<string>()
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    if (seen.has(hit.id)) return `${hit.id} appears twice`
    seen.add(hit.id)
    if (i > 0 && hit.score > hits[i - 1].score + SCORE_TOLERANCE) return `${hit.id} outranks a higher score`
    const heldBy = libraries.some(library => {
      const paper = library.get(hit.id)
      if (paper === undefined || !passes(paper.shelf)) return false
      return Math.abs(hit.score - cosine(query, paper.embedding)) <= SCORE_TOLERANCE
    })
    if (!heldBy) return `${hit.id} scored ${hit.score}, which no library holds for a paper the filter accepts`
  }
  return null
}

export async function expectSoundAnswersWhile(
  ask: AskDuringChange,
  libraries: readonly Library[],
  stage: string,
  stillChanging: () => boolean,
  refusals: ReadonlySet<string>,
): Promise<ConcurrentAnswers> {
  const counts: ConcurrentAnswers = { complete: 0, partial: 0, refused: 0 }
  const deadline = Date.now() + CONCURRENT_DEADLINE_MS
  for (let pass = 1; ; pass++) {
    for (const { share, filters, passes } of selectivities) {
      for (const query of queries) {
        const answer = await ask(query, filters)
        if ('refusedWith' in answer) {
          expect(refusals.has(answer.refusedWith), `${stage} at ${share} refused with ${answer.refusedWith}`).toBe(true)
          counts.refused += 1
        } else {
          expect(unsoundHit(libraries, query, passes, answer.hits), `${stage} at ${share}`).toBeNull()
          const complete = libraries.some(library => problemWith(library, query, passes, answer.hits) === null)
          if (complete) counts.complete += 1
          else counts.partial += 1
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    if (!stillChanging()) return counts
    if (pass >= MAX_CONCURRENT_PASSES || Date.now() > deadline) {
      throw new Error(`${stage} was still running after ${pass} passes of filtered queries`)
    }
  }
}
