import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const DIM = 16
const DOCUMENT_COUNT = 1000
const BATCH_SIZE = 250
const QUERY_COUNT = 40
const K = 10
const EF_SEARCH = 64

const indexConfig: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIM}]` },
  vectorPromotion: {
    threshold: BATCH_SIZE,
    quantization: 'none',
    hnswConfig: { m: 16, efConstruction: 200, metric: 'cosine' },
  },
}

type Document = {
  id: string
  title: string
  embedding: number[]
}

function unitVector(seed: number): number[] {
  const values: number[] = []
  let sumSquares = 0
  for (let i = 0; i < DIM; i++) {
    const value = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
    values.push(value)
    sumSquares += value * value
  }
  const length = Math.sqrt(sumSquares)
  return values.map(value => value / length)
}

const documents: Document[] = Array.from({ length: DOCUMENT_COUNT }, (_, i) => ({
  id: `doc${i}`,
  title: `document ${i}`,
  embedding: unitVector(i + 1),
}))

const queries = Array.from({ length: QUERY_COUNT }, (_, q) => unitVector(q * 13 + 5))

function exactTopK(query: number[]): Set<string> {
  const scored = documents.map(document => {
    let dot = 0
    for (let i = 0; i < DIM; i++) dot += query[i] * document.embedding[i]
    return { id: document.id, score: dot }
  })
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  return new Set(scored.slice(0, K).map(entry => entry.id))
}

const exactAnswers = queries.map(exactTopK)

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function untilGraphIdle(narsil: Narsil, indexName: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (narsil.vectorMaintenanceStatus(indexName).some(field => field.building)) {
    if (Date.now() > deadline) throw new Error(`the graph of ${indexName} was still building after 20 s`)
    await pause(5)
  }
}

async function recallAtK(narsil: Narsil, indexName: string): Promise<number> {
  let hits = 0
  for (let q = 0; q < QUERY_COUNT; q++) {
    const result = await narsil.query(indexName, {
      mode: 'vector',
      limit: K,
      vector: { field: 'embedding', value: queries[q], metric: 'cosine', efSearch: EF_SEARCH },
    })
    for (const hit of result.hits) {
      if (exactAnswers[q].has(hit.id)) hits++
    }
  }
  return hits / (QUERY_COUNT * K)
}

describe('a graph grown batch by batch against one built in a single batch', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('single', indexConfig)
    await narsil.createIndex('grown', indexConfig)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('answers with the same recall after optimise', async () => {
    await narsil.insertBatch('single', documents)
    await narsil.optimizeVectors('single', 'embedding')

    for (let start = 0; start < DOCUMENT_COUNT; start += BATCH_SIZE) {
      await narsil.insertBatch('grown', documents.slice(start, start + BATCH_SIZE))
      await untilGraphIdle(narsil, 'grown')
    }
    await narsil.optimizeVectors('grown', 'embedding')

    const singleRecall = await recallAtK(narsil, 'single')
    const grownRecall = await recallAtK(narsil, 'grown')

    expect(singleRecall).toBeGreaterThanOrEqual(0.95)
    expect(grownRecall).toBeGreaterThanOrEqual(0.95)
    expect(Math.abs(singleRecall - grownRecall)).toBeLessThanOrEqual(0.03)
  }, 60_000)
})
