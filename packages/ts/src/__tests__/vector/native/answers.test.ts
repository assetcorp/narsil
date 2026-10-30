import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { VectorQuantizationMode } from '../../../types/schema'
import { seededRandom } from '../../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'

const DIMENSION = 53
const DOCUMENTS = 600
const QUERIES = 40
const K = 10
const RECALL_FLOOR = 0.9
const SCORE_TOLERANCE = 1e-4
const SETTLE_DEADLINE_MS = 20_000
const TEST_TIMEOUT_MS = 60_000
const QUANTIZATIONS: VectorQuantizationMode[] = ['none', 'osq8', 'osq4', 'osq2', 'osq1']

searchThrough('native')

const random = seededRandom(20260918)
const centres = Array.from({ length: 12 }, () => Array.from({ length: DIMENSION }, () => random() * 2 - 1))

function nearCentre(): number[] {
  const centre = centres[Math.floor(random() * centres.length)]
  return centre.map(value => Math.fround(value + (random() - 0.5) * 0.6))
}

const lamps = Array.from({ length: DOCUMENTS }, (_, position) => ({ id: `lamp-${position}`, embedding: nearCentre() }))
const queries = Array.from({ length: QUERIES }, nearCentre)

function cosine(left: number[], right: number[]): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]
    leftSquared += left[i] * left[i]
    rightSquared += right[i] * right[i]
  }
  return dot / Math.sqrt(leftSquared * rightSquared)
}

function exactNearest(query: number[], kept: typeof lamps): Array<{ id: string; score: number }> {
  return kept
    .map(lamp => ({ id: lamp.id, score: cosine(query, lamp.embedding) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, K)
}

async function settledGraph(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (narsil.vectorMaintenanceStatus('lamps').some(field => field.building || field.bufferSize > 0)) {
    if (Date.now() > deadline) throw new Error('the graph was still building at the deadline')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe.skipIf(!backendAvailable('native'))('a vector search through the native core and the public API', () => {
  let narsil: Narsil | null = null

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
  })

  it(
    'scores every document as an exact search does while the field holds no graph',
    async () => {
      const opened = await createNarsil({ workers: { enabled: false } })
      narsil = opened
      await opened.createIndex('lamps', {
        schema: { embedding: `vector[${DIMENSION}]` },
        vectorPromotion: { threshold: DOCUMENTS * 2 },
      })
      expect((await opened.insertBatch('lamps', lamps)).failed).toEqual([])
      for (const query of queries) {
        const result = await opened.query('lamps', {
          mode: 'vector',
          limit: K,
          vector: { field: 'embedding', value: query },
        })
        const truth = exactNearest(query, lamps)
        expect(result.hits.map(hit => hit.id)).toEqual(truth.map(entry => entry.id))
        result.hits.forEach((hit, position) => {
          expect(Math.abs((hit.score ?? Number.NaN) - truth[position].score)).toBeLessThan(SCORE_TOLERANCE)
        })
      }
    },
    TEST_TIMEOUT_MS,
  )

  for (const quantization of QUANTIZATIONS) {
    it(
      `finds the nearest documents under ${quantization}, before and after a third of them leave`,
      async () => {
        const opened = await createNarsil({ workers: { enabled: false } })
        narsil = opened
        await opened.createIndex('lamps', {
          schema: { embedding: `vector[${DIMENSION}]` },
          vectorPromotion: { threshold: 50, quantization, hnswConfig: { m: 8, efConstruction: 60 } },
        })
        expect((await opened.insertBatch('lamps', lamps)).failed).toEqual([])
        await settledGraph(opened)

        async function recallOver(kept: typeof lamps): Promise<number> {
          let found = 0
          for (const query of queries) {
            const result = await opened.query('lamps', {
              mode: 'vector',
              limit: K,
              vector: { field: 'embedding', value: query, efSearch: 128, oversample: 10 },
            })
            const truth = new Set(exactNearest(query, kept).map(entry => entry.id))
            found += result.hits.filter(hit => truth.has(hit.id)).length
          }
          return found / (K * QUERIES)
        }

        expect(await recallOver(lamps)).toBeGreaterThanOrEqual(RECALL_FLOOR)

        const leaving = lamps.filter((_, position) => position % 3 === 0)
        for (const lamp of leaving) await opened.remove('lamps', lamp.id)
        await settledGraph(opened)
        const kept = lamps.filter((_, position) => position % 3 !== 0)
        expect(await recallOver(kept)).toBeGreaterThanOrEqual(RECALL_FLOOR)
      },
      TEST_TIMEOUT_MS,
    )
  }
})
