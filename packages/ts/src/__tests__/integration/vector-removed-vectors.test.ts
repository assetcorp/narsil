import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { loadNativeCore } from '../../vector/native/loader'
import type { VectorSearchPool } from '../../vector/search-pool'
import { binaryBuilt, pointAtTheHostBinary, seededRandom } from '../vector/native/fixtures'

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

const DIMENSION = 32
const DOCUMENT_COUNT = 300
const WORKER_DOCUMENT_COUNT = 1200
const RING_DOCUMENT_COUNT = 3000
const KEPT_EVERY = 10
const QUERY_COUNT = 20
const RING_QUERY_COUNT = 50
const K = 10
const FAR_AWAY_OFFSET = 20
const RING_WIDTH = 10
const LIVE_RING_RECALL_FLOOR = 0.94
const SAVED_RING_RECALL_FLOOR = 0.9
const SETTLE_DEADLINE_MS = 20_000

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

interface Corpus {
  documents: Paper[]
  kept: Paper[]
  changed: Paper[]
  reembedded: Paper[]
}

const random = seededRandom(20261026)

function randomVector(): number[] {
  return Array.from({ length: DIMENSION }, () => random() * 2 - 1)
}

function corpusOf(count: number): Corpus {
  const documents: Paper[] = Array.from({ length: count }, (_, i) => ({
    id: `paper-${String(i).padStart(4, '0')}`,
    embedding: randomVector(),
  }))
  const changed = documents.filter((_, i) => i % KEPT_EVERY !== 0)
  return {
    documents,
    kept: documents.filter((_, i) => i % KEPT_EVERY === 0),
    changed,
    reembedded: changed.map(document => ({
      id: document.id,
      embedding: document.embedding.map(value => value + FAR_AWAY_OFFSET),
    })),
  }
}

const small = corpusOf(DOCUMENT_COUNT)
const large = corpusOf(WORKER_DOCUMENT_COUNT)
const queries = Array.from({ length: QUERY_COUNT }, randomVector)
const ringDocuments = corpusOf(RING_DOCUMENT_COUNT).documents
const ringQueries = Array.from({ length: RING_QUERY_COUNT }, randomVector)

function ranked(current: Paper[], query: number[]): string[] {
  const scored = current.map(document => {
    let squared = 0
    for (let i = 0; i < DIMENSION; i++) squared += (query[i] - document.embedding[i]) ** 2
    return { id: document.id, squared }
  })
  scored.sort((a, b) => a.squared - b.squared)
  return scored.map(entry => entry.id)
}

function nearest(current: Paper[], query: number[]): string[] {
  return ranked(current, query).slice(0, K)
}

const ring = new Set<string>()
for (const query of ringQueries) {
  for (const id of ranked(ringDocuments, query).slice(K, K + RING_WIDTH)) ring.add(id)
}
const outsideTheRing = ringDocuments.filter(document => !ring.has(document.id))

function search(narsil: Narsil, query: number[]) {
  return narsil.query('papers', {
    mode: 'vector',
    limit: K,
    vector: { field: 'embedding', value: query, metric: 'euclidean' },
  })
}

async function expectNearest(narsil: Narsil, current: Paper[]): Promise<void> {
  for (const query of queries) {
    const result = await search(narsil, query)
    expect(result.hits.map(hit => hit.id)).toEqual(nearest(current, query))
  }
}

async function ringRecall(narsil: Narsil): Promise<number> {
  let found = 0
  for (const query of ringQueries) {
    const truth = new Set(nearest(outsideTheRing, query))
    const result = await search(narsil, query)
    found += result.hits.filter(hit => truth.has(hit.id)).length
  }
  return found / (K * ringQueries.length)
}

async function untilGraphSettled(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus('papers')
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error('the graph of papers was still building after 20 s')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function openPapers(config: NarsilConfig, documents: Paper[]): Promise<Narsil> {
  const narsil = await createNarsil(config)
  await narsil.createIndex('papers', indexConfig)
  await narsil.insertBatch('papers', documents)
  await untilGraphSettled(narsil)
  return narsil
}

async function reembed(narsil: Narsil, corpus: Corpus): Promise<void> {
  const result = await narsil.updateBatch(
    'papers',
    corpus.reembedded.map(document => ({ docId: document.id, document })),
  )
  expect(result.failed).toEqual([])
  await untilGraphSettled(narsil)
}

async function removeChanged(narsil: Narsil, corpus: Corpus): Promise<void> {
  const result = await narsil.removeBatch(
    'papers',
    corpus.changed.map(document => document.id),
  )
  expect(result.failed).toEqual([])
}

async function openPapersWithoutTheRing(config: NarsilConfig): Promise<Narsil> {
  const narsil = await openPapers(config, ringDocuments)
  const result = await narsil.removeBatch('papers', [...ring])
  expect(result.failed).toEqual([])
  return narsil
}

const backends = [
  { name: 'the TypeScript search', native: false, available: true },
  { name: 'the C search', native: true, available: binaryBuilt },
]

let restoreHostPath: () => void = () => {}

beforeAll(() => {
  if (!binaryBuilt) return
  restoreHostPath = pointAtTheHostBinary()
  loadNativeCore()
})

afterAll(() => {
  restoreHostPath()
})

describe.each(backends)('a vector search past tombstones through $name', ({ native, available }) => {
  let narsil: Narsil | null = null
  const fallbacks: NativeOperation[] = []

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    fallbacks.length = 0
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(async () => {
    observeFallbacks(null)
    await narsil?.shutdown()
    narsil = null
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!available)('returns the nearest live vectors after most vectors are removed', async () => {
    const opened = await openPapers({ workers: { enabled: false } }, small.documents)
    narsil = opened
    await removeChanged(opened, small)
    await expectNearest(opened, small.kept)
    expect(fallbacks.includes('search')).toBe(!native)
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0.8)
  })

  it.skipIf(!available)('returns the nearest vectors after most documents are re-embedded far away', async () => {
    const opened = await openPapers({ workers: { enabled: false } }, small.documents)
    narsil = opened
    await reembed(opened, small)
    await expectNearest(opened, [...small.kept, ...small.reembedded])
    expect(fallbacks.includes('search')).toBe(!native)
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0)
    await opened.compactVectors('papers', 'embedding')
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBe(0)
  })

  it.skipIf(!available)("keeps its recall once the ring beyond each query's nearest ten is removed", async () => {
    const opened = await openPapersWithoutTheRing({ workers: { enabled: false } })
    narsil = opened
    expect(await ringRecall(opened)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    expect(fallbacks.includes('search')).toBe(!native)
  })
})

const changes = [
  { change: 'most vectors are removed', apply: removeChanged, current: (corpus: Corpus) => corpus.kept },
  {
    change: 'most documents are re-embedded far away',
    apply: reembed,
    current: (corpus: Corpus) => [...corpus.kept, ...corpus.reembedded],
  },
]

async function restartAfterCheckpoint(directory: string, writer: Narsil): Promise<Narsil> {
  await writer.checkpoint('papers')
  await writer.shutdown()
  const reader = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  await untilGraphSettled(reader)
  return reader
}

async function restoreSnapshotOf(source: Narsil): Promise<Narsil> {
  const bytes = await source.snapshot('papers')
  const restored = await createNarsil({ workers: { enabled: false } })
  await restored.createIndex('papers', indexConfig)
  await restored.restore('papers', bytes)
  await source.shutdown()
  await untilGraphSettled(restored)
  return restored
}

describe.each(backends)('a vector search past tombstones carried to another copy through $name', ({
  native,
  available,
}) => {
  let directory = ''
  let narsil: Narsil | null = null

  beforeEach(async () => {
    setNativeSearchCoreEnabled(native)
    directory = await mkdtemp(join(tmpdir(), 'narsil-tombstones-'))
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    setNativeSearchCoreEnabled(true)
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(!available).each(changes)(
    'answers after a checkpoint and a restart once $change',
    async ({ apply, current }) => {
      const writer = await openPapers({ workers: { enabled: false }, durability: { directory } }, large.documents)
      await apply(writer, large)
      narsil = await restartAfterCheckpoint(directory, writer)
      await expectNearest(narsil, current(large))
    },
  )

  it.skipIf(!available).each(changes)('answers after a snapshot restore once $change', async ({ apply, current }) => {
    const source = await openPapers({ workers: { enabled: false } }, large.documents)
    await apply(source, large)
    narsil = await restoreSnapshotOf(source)
    await expectNearest(narsil, current(large))
  })

  it.skipIf(!available)(
    "keeps its recall after a checkpoint and a restart once the ring beyond each query's nearest ten is removed",
    async () => {
      const writer = await openPapersWithoutTheRing({ workers: { enabled: false }, durability: { directory } })
      narsil = await restartAfterCheckpoint(directory, writer)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(SAVED_RING_RECALL_FLOOR)
    },
  )

  it.skipIf(!available)(
    "keeps its recall after a snapshot restore once the ring beyond each query's nearest ten is removed",
    async () => {
      const source = await openPapersWithoutTheRing({ workers: { enabled: false } })
      narsil = await restoreSnapshotOf(source)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(SAVED_RING_RECALL_FLOOR)
    },
  )
})

const workerPaths = [
  { path: 'shared memory', clones: false },
  { path: 'a cloned copy', clones: true },
]

async function untilWorkersAnswer(narsil: Narsil, clones: boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  const answered = () => (clones ? poolUse.clonedSearches : poolUse.sharedSearches)
  const before = answered()
  while (answered() === before) {
    if (Date.now() > deadline) throw new Error('no worker copy answered a search of papers after 20 s')
    await search(narsil, queries[0])
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe.each(backends)('a vector search past re-embedded vectors on worker copies through $name', ({
  native,
  available,
}) => {
  const workerBackendVariable = native ? 'NARSIL_REQUIRE_NATIVE_CORE' : 'NARSIL_SEARCH_BACKEND'
  const previousValue = process.env[workerBackendVariable]
  let narsil: Narsil | null = null

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    process.env[workerBackendVariable] = native ? '1' : 'wasm'
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    vi.unstubAllGlobals()
    setNativeSearchCoreEnabled(true)
    if (previousValue === undefined) delete process.env[workerBackendVariable]
    else process.env[workerBackendVariable] = previousValue
    expect(poolUse.holders).toBe(0)
  })

  it.skipIf(!available).each(workerPaths)('answers from worker copies over $path', async ({ clones }) => {
    expect(poolUse.holders).toBe(0)
    if (clones) vi.stubGlobal('SharedArrayBuffer', undefined)
    const opened = await openPapers({ workers: { count: 2 } }, large.documents)
    narsil = opened
    await reembed(opened, large)
    await untilWorkersAnswer(opened, clones)

    const answeredBefore = clones ? poolUse.clonedSearches : poolUse.sharedSearches
    await expectNearest(opened, [...large.kept, ...large.reembedded])
    const answeredAfter = clones ? poolUse.clonedSearches : poolUse.sharedSearches
    expect(answeredAfter - answeredBefore).toBe(QUERY_COUNT)
  })
})
