import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { binaryBuilt, pointAtTheHostBinary, seededRandom } from '../vector/native/fixtures'

const DIMENSION = 32
const DOCUMENT_COUNT = 300
const KEPT_EVERY = 10
const QUERY_COUNT = 20
const K = 10
const FAR_AWAY_OFFSET = 20

const indexConfig: IndexConfig = {
  schema: { embedding: `vector[${DIMENSION}]` },
  vectorPromotion: {
    threshold: 50,
    quantization: 'none',
    hnswConfig: { m: 8, efConstruction: 60, metric: 'euclidean' },
  },
}

type Paper = AnyDocument & {
  id: string
  embedding: number[]
}

const random = seededRandom(20261026)
const documents: Paper[] = Array.from({ length: DOCUMENT_COUNT }, (_, i) => ({
  id: `paper-${String(i).padStart(3, '0')}`,
  embedding: Array.from({ length: DIMENSION }, () => random() * 2 - 1),
}))
const kept = documents.filter((_, i) => i % KEPT_EVERY === 0)
const changed = documents.filter((_, i) => i % KEPT_EVERY !== 0)
const reembedded: Paper[] = changed.map(document => ({
  id: document.id,
  embedding: document.embedding.map(value => value + FAR_AWAY_OFFSET),
}))
const queries = Array.from({ length: QUERY_COUNT }, () => Array.from({ length: DIMENSION }, () => random() * 2 - 1))

function nearest(current: Paper[], query: number[]): string[] {
  const scored = current.map(document => {
    let squared = 0
    for (let i = 0; i < DIMENSION; i++) squared += (query[i] - document.embedding[i]) ** 2
    return { id: document.id, squared }
  })
  scored.sort((a, b) => a.squared - b.squared)
  return scored.slice(0, K).map(entry => entry.id)
}

async function untilGraphSettled(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + 20_000
  while (
    narsil
      .vectorMaintenanceStatus('papers')
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error('the graph of papers was still building after 20 s')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const backends = [
  { name: 'the TypeScript search', native: false, available: true },
  { name: 'the C search', native: true, available: binaryBuilt },
]

describe.each(backends)('a vector search past tombstones through $name', ({ native, available }) => {
  let narsil: Narsil
  let restorePath: () => void = () => {}
  const fallbacks: NativeOperation[] = []

  beforeAll(() => {
    if (native) restorePath = pointAtTheHostBinary()
  })

  afterAll(() => {
    restorePath()
  })

  beforeEach(async () => {
    setNativeSearchCoreEnabled(native)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('papers', indexConfig)
    await narsil.insertBatch('papers', documents)
    await untilGraphSettled(narsil)
    fallbacks.length = 0
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(async () => {
    observeFallbacks(null)
    await narsil.shutdown()
    setNativeSearchCoreEnabled(true)
  })

  async function expectNearest(current: Paper[]): Promise<void> {
    for (const query of queries) {
      const result = await narsil.query('papers', {
        mode: 'vector',
        limit: K,
        vector: { field: 'embedding', value: query, metric: 'euclidean' },
      })
      expect(result.hits.map(hit => hit.id)).toEqual(nearest(current, query))
    }
    expect(fallbacks.includes('search')).toBe(!native)
  }

  it.skipIf(!available)('returns the nearest live vectors after most vectors are removed', async () => {
    const result = await narsil.removeBatch(
      'papers',
      changed.map(document => document.id),
    )
    expect(result.failed).toEqual([])
    await expectNearest(kept)
    expect(narsil.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0.8)
  })

  it.skipIf(!available)('returns the nearest vectors after most documents are re-embedded far away', async () => {
    const result = await narsil.updateBatch(
      'papers',
      reembedded.map(document => ({ docId: document.id, document })),
    )
    expect(result.failed).toEqual([])
    await untilGraphSettled(narsil)
    await expectNearest([...kept, ...reembedded])
    expect(narsil.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0)
    await narsil.compactVectors('papers', 'embedding')
    expect(narsil.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBe(0)
  })
})
