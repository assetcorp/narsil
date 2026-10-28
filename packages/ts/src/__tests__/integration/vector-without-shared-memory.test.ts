import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { IndexConfig, VectorQuantizationMode } from '../../types/schema'
import type { VectorSearchPool } from '../../vector/search-pool'
import { seededRandom } from '../vector/native/fixtures'

const poolUse = vi.hoisted(() => ({ holders: 0, clonedSearches: 0, sharedSearches: 0 }))

vi.mock('../../vector/search-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vector/search-pool')>()
  function counted(pool: VectorSearchPool): VectorSearchPool {
    return {
      ...pool,
      search(...args) {
        poolUse.clonedSearches += 1
        return pool.search(...args)
      },
      searchOrdinals(...args) {
        poolUse.sharedSearches += 1
        return pool.searchOrdinals(...args)
      },
    }
  }
  return {
    ...actual,
    async acquireVectorSearchPool(requestedCount?: number) {
      poolUse.holders += 1
      const pool = await actual.acquireVectorSearchPool(requestedCount)
      return pool === null ? null : counted(pool)
    },
    async releaseVectorSearchPool() {
      if (poolUse.holders > 0) poolUse.holders -= 1
      await actual.releaseVectorSearchPool()
    },
  }
})

const DIMENSION = 384
const CLUSTER_COUNT = 40
const BATCH_SIZE = 400
const BATCH_COUNT = 8
const LATE_BATCH_COUNT = 2
const REMOVED_EVERY = 7
const PROMOTION_THRESHOLD = 200
const QUERY_COUNT = 30
const K = 10
const EF_SEARCH = 200
const FINE_CODE_RECALL_FLOOR = 0.95
const COARSE_CODE_RECALL_FLOOR = 0.6
const SCORE_DIGITS = 4
const SETTLE_DEADLINE_MS = 60_000

const modes: Array<{ quantization: VectorQuantizationMode; recallFloor: number }> = [
  { quantization: 'osq8', recallFloor: FINE_CODE_RECALL_FLOOR },
  { quantization: 'osq4', recallFloor: FINE_CODE_RECALL_FLOOR },
  { quantization: 'osq2', recallFloor: COARSE_CODE_RECALL_FLOOR },
  { quantization: 'osq1', recallFloor: COARSE_CODE_RECALL_FLOOR },
  { quantization: 'none', recallFloor: FINE_CODE_RECALL_FLOOR },
]

type Paper = { id: string; embedding: number[] }

const random = seededRandom(20261027)

function gaussian(): number {
  const u = Math.max(random(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

const centres = Array.from({ length: CLUSTER_COUNT }, () => Array.from({ length: DIMENSION }, gaussian))

function nearCentre(index: number, spread: number): number[] {
  return centres[index % CLUSTER_COUNT].map(value => value + spread * gaussian())
}

const papers: Paper[] = Array.from({ length: (BATCH_COUNT + LATE_BATCH_COUNT) * BATCH_SIZE }, (_, i) => ({
  id: `paper-${i}`,
  embedding: nearCentre(i, 0.6),
}))
const earlyPapers = papers.slice(0, BATCH_COUNT * BATCH_SIZE)
const latePapers = papers.slice(BATCH_COUNT * BATCH_SIZE)
const queries = Array.from({ length: QUERY_COUNT }, (_, i) => nearCentre(i * 7, 0.6))

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / Math.sqrt(normA * normB)
}

function exactNearest(live: Map<string, number[]>, query: number[]): string[] {
  const scored = [...live].map(([id, embedding]) => ({ id, score: cosine(query, embedding) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, K).map(entry => entry.id)
}

function indexConfigOf(quantization: VectorQuantizationMode): IndexConfig {
  return {
    schema: { embedding: `vector[${DIMENSION}]` },
    vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization, hnswConfig: { metric: 'cosine' } },
  }
}

async function untilGraphSettled(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus('papers')
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error('the graph of papers was still building after 60 s')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function insertRemovingSome(narsil: Narsil, live: Map<string, number[]>, batch: Paper[]): Promise<void> {
  const inserted = await narsil.insertBatch('papers', batch)
  expect(inserted.failed).toEqual([])
  for (const paper of batch) live.set(paper.id, paper.embedding)
  const removed = batch.filter((_, i) => i % REMOVED_EVERY === 0).map(paper => paper.id)
  const result = await narsil.removeBatch('papers', removed)
  expect(result.failed).toEqual([])
  for (const id of removed) live.delete(id)
}

async function openPapers(config: NarsilConfig, quantization: VectorQuantizationMode, live: Map<string, number[]>) {
  const narsil = await createNarsil(config)
  await narsil.createIndex('papers', indexConfigOf(quantization))
  for (let start = 0; start < earlyPapers.length; start += BATCH_SIZE) {
    await insertRemovingSome(narsil, live, earlyPapers.slice(start, start + BATCH_SIZE))
  }
  await untilGraphSettled(narsil)
  return narsil
}

async function expectAnswersAgainstTheExactScan(
  narsil: Narsil,
  live: Map<string, number[]>,
  recallFloor: number,
): Promise<void> {
  let found = 0
  for (const query of queries) {
    const result = await narsil.query('papers', {
      mode: 'vector',
      limit: K,
      vector: { field: 'embedding', value: query, metric: 'cosine', efSearch: EF_SEARCH },
    })
    expect(result.hits).toHaveLength(K)
    const truth = new Set(exactNearest(live, query))
    for (const hit of result.hits) {
      const embedding = live.get(hit.id)
      expect(embedding, `${hit.id} was removed or never inserted`).toBeDefined()
      if (embedding === undefined) continue
      expect(hit.score).toBeCloseTo(cosine(query, embedding), SCORE_DIGITS)
      if (truth.has(hit.id)) found += 1
    }
  }
  expect(found / (K * QUERY_COUNT)).toBeGreaterThanOrEqual(recallFloor)
}

async function untilClonedCopiesAnswer(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  const before = poolUse.clonedSearches
  while (poolUse.clonedSearches === before) {
    if (Date.now() > deadline) throw new Error('no cloned worker copy answered a search of papers after 60 s')
    await narsil.query('papers', { mode: 'vector', limit: K, vector: { field: 'embedding', value: queries[0] } })
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('a quantised vector field in a runtime without SharedArrayBuffer', () => {
  let narsil: Narsil | null = null
  let restored: Narsil | null = null

  afterEach(async () => {
    await narsil?.shutdown()
    await restored?.shutdown()
    narsil = null
    restored = null
    vi.unstubAllGlobals()
  })

  it.each(modes)('promotes, grows, searches, and survives a snapshot restore at $quantization', async ({
    quantization,
    recallFloor,
  }) => {
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const live = new Map<string, number[]>()
    narsil = await openPapers({ workers: { enabled: false } }, quantization, live)
    await expectAnswersAgainstTheExactScan(narsil, live, recallFloor)

    const bytes = await narsil.snapshot('papers')
    restored = await createNarsil({ workers: { enabled: false } })
    await restored.createIndex('papers', indexConfigOf(quantization))
    await restored.restore('papers', bytes)
    await untilGraphSettled(restored)
    await expectAnswersAgainstTheExactScan(restored, live, recallFloor)

    const restoredLive = new Map(live)
    for (let start = 0; start < latePapers.length; start += BATCH_SIZE) {
      await insertRemovingSome(restored, restoredLive, latePapers.slice(start, start + BATCH_SIZE))
    }
    await untilGraphSettled(restored)
    await expectAnswersAgainstTheExactScan(restored, restoredLive, recallFloor)
  }, 120_000)

  it.each(modes)('answers from worker copies that receive cloned memory at $quantization', async ({
    quantization,
    recallFloor,
  }) => {
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const live = new Map<string, number[]>()
    narsil = await openPapers({ workers: { count: 2 } }, quantization, live)
    await untilClonedCopiesAnswer(narsil)
    const answeredBefore = poolUse.clonedSearches
    await expectAnswersAgainstTheExactScan(narsil, live, recallFloor)
    expect(poolUse.clonedSearches - answeredBefore).toBe(QUERY_COUNT)
  }, 120_000)
})
