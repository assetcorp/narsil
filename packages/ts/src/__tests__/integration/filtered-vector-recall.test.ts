import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'
import type { VectorQuantizationMode } from '../../types/schema'
import { setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { seededRandom } from '../vector/native/fixtures'
import { backends, openPapers, type Paper, searchWithTheHostBinary } from './removed-vectors/fixtures'

const DIMENSION = 32
const DOCUMENTS = 4_000
const QUERIES = 40
const K = 10
const SHELVES = 20
const CENTRES = 24
const SPREAD = 0.5
const PROMOTION_THRESHOLD = 100
const RECALL_FLOOR = 0.95
const QUANTIZATIONS: VectorQuantizationMode[] = ['none', 'osq4', 'osq1']

const random = seededRandom(20261027)
const centres = Array.from({ length: CENTRES }, () => Array.from({ length: DIMENSION }, () => random() * 2 - 1))

function nearCentre(): number[] {
  const centre = centres[Math.floor(random() * CENTRES)]
  return centre.map(value => Math.fround(value + (random() - 0.5) * SPREAD))
}

type ShelvedPaper = Paper & { shelf: number }

const papers: ShelvedPaper[] = Array.from({ length: DOCUMENTS }, (_, i) => ({
  id: `paper-${String(i).padStart(4, '0')}`,
  shelf: Math.floor(random() * SHELVES),
  embedding: nearCentre(),
}))
const queries = Array.from({ length: QUERIES }, nearCentre)

const selectivities = [
  { share: '5%', filters: { fields: { shelf: { eq: 0 } } }, passes: (shelf: number) => shelf === 0 },
  { share: '20%', filters: { fields: { shelf: { lt: 4 } } }, passes: (shelf: number) => shelf < 4 },
] satisfies { share: string; filters: FilterExpression; passes: (shelf: number) => boolean }[]

function cosine(a: number[], b: number[]): number {
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

function exactFilteredNearest(query: number[], passes: (shelf: number) => boolean): string[] {
  return papers
    .filter(paper => passes(paper.shelf))
    .map(paper => ({ id: paper.id, score: cosine(query, paper.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
    .map(entry => entry.id)
}

searchWithTheHostBinary()

describe.each(backends)('a filtered vector search through $name', ({ native, available }) => {
  let narsil: Narsil | null = null

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    setNativeSearchCoreEnabled(true)
  })

  for (const quantization of QUANTIZATIONS) {
    it.skipIf(!available)(
      `finds the nearest matching documents under ${quantization} at 5% and 20% of the documents`,
      async () => {
        const opened = await openPapers({ workers: { enabled: false } }, papers, {
          schema: { shelf: 'number', embedding: `vector[${DIMENSION}]` },
          vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization },
        })
        narsil = opened
        const shelfOf = new Map(papers.map(paper => [paper.id, paper.shelf]))
        for (const { share, filters, passes } of selectivities) {
          let found = 0
          for (const query of queries) {
            const result = await opened.query('papers', {
              mode: 'vector',
              limit: K,
              filters,
              vector: { field: 'embedding', value: query },
            })
            const shelves = result.hits.map(hit => shelfOf.get(hit.id))
            expect(shelves.every(shelf => shelf !== undefined && passes(shelf))).toBe(true)
            const truth = new Set(exactFilteredNearest(query, passes))
            found += result.hits.filter(hit => truth.has(hit.id)).length
          }
          expect(found / (K * QUERIES), `recall@${K} at ${share}`).toBeGreaterThanOrEqual(RECALL_FLOOR)
        }
      },
    )
  }
})
