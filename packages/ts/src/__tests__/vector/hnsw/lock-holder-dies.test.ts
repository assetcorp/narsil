import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, isNarsilError } from '../../../errors'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { noteThreadSlotGone, noteThreadSlotLive } from '../../../workers/thread-slot'

const DEADLINE_MS = vi.hoisted(() => 1_000)

vi.mock('../../../vector/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../vector/constants')>()),
  GRAPH_LOCK_WAIT_DEADLINE_MS: DEADLINE_MS,
}))

const SLACK_MS = 3_000
const HOLDER_SLOT = 40
const DIMENSION = 32
const DOCUMENTS = 300
const K = 5

type HeldLock = 'node' | 'graph' | 'graphWaiting' | 'graphAlone' | 'entry'

const HOLDER = `
const { parentPort, workerData } = require('node:worker_threads')
const { lock, slot, header, held, locks, ord } = workerData
const base = slot * 32
if (lock === 'node') {
  const words = new Int32Array(locks)
  const seen = Atomics.load(words, ord)
  const claimed = seen | 1
  if (Atomics.compareExchange(words, ord, seen, claimed) !== seen) throw new Error('the node was taken')
  Atomics.store(held, base + 1, claimed)
  Atomics.store(held, base, ord + 1)
} else if (lock === 'graph') {
  const seen = Atomics.load(header, 96)
  if (Atomics.compareExchange(header, 96, seen, seen + 1) !== seen) throw new Error('the graph was taken')
  Atomics.store(held, base + 2, 1)
} else if (lock === 'graphWaiting') {
  Atomics.store(held, base + 4, 1)
  Atomics.add(header, 97, 1)
} else if (lock === 'graphAlone') {
  if (Atomics.compareExchange(header, 96, 0, -1) !== 0) throw new Error('the graph was taken')
} else if (lock === 'entry') {
  if (Atomics.compareExchange(header, 128, 0, -1) !== 0) throw new Error('the entry point was taken')
  Atomics.store(held, base + 5, 1)
}
parentPort.postMessage('held')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
`

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const next = seeded(20261029)
const vectors = Array.from({ length: DOCUMENTS + 1 }, () => {
  const vector = new Float32Array(DIMENSION)
  for (let d = 0; d < DIMENSION; d++) vector[d] = next() - 0.5
  return vector
})

interface Field {
  store: VectorStore
  graph: HNSWIndex
}

function openField(placed: number): Field {
  const store = createVectorStore({ dimension: DIMENSION, codeBits: null })
  for (let i = 0; i < vectors.length; i++) store.insert(`doc-${i}`, vectors[i])
  const graph = createHNSWIndex(DIMENSION, store, { m: 16, efConstruction: 100, metric: 'cosine' })
  for (let i = 0; i < placed; i++) graph.insertOrdinal(ordinalOf(store, i))
  return { store, graph }
}

function ordinalOf(store: VectorStore, i: number): number {
  const ordinal = store.getOrdinal(`doc-${i}`)
  if (ordinal === undefined) throw new Error(`doc-${i} holds no ordinal`)
  return ordinal
}

async function holdLock(field: Field, lock: HeldLock, ord = 0): Promise<Worker> {
  const { header, heldLocks, locks } = field.graph.handles
  const worker = new Worker(HOLDER, {
    eval: true,
    workerData: { lock, slot: HOLDER_SLOT, header, held: heldLocks, locks, ord },
  })
  noteThreadSlotLive(HOLDER_SLOT)
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return worker
}

async function killHolder(worker: Worker): Promise<void> {
  await worker.terminate()
  noteThreadSlotGone(HOLDER_SLOT)
}

function timed<T>(work: () => T): { value?: T; error?: unknown; ms: number } {
  const started = performance.now()
  try {
    const value = work()
    return { value, ms: performance.now() - started }
  } catch (error) {
    return { error, ms: performance.now() - started }
  }
}

function searchFor(field: Field, i: number) {
  return timed(() => field.graph.search(vectors[i], K, 'cosine', -1, { efSearch: 64 }))
}

function heldWordsOf(field: Field): number[] {
  const base = HOLDER_SLOT * 32
  return Array.from(field.graph.handles.heldLocks.subarray(base, base + 6))
}

describe('a main-thread search while a dead or stuck thread holds a lock on the vector graph', () => {
  let holder: Worker | null = null

  beforeAll(() => {
    setNativeSearchCoreEnabled(false)
  })

  afterAll(() => {
    setNativeSearchCoreEnabled(true)
  })

  afterEach(async () => {
    await holder?.terminate()
    holder = null
    noteThreadSlotLive(HOLDER_SLOT)
  })

  it('answers once the deadline releases the node lock of a writer that died', async () => {
    const field = openField(DOCUMENTS)
    const entry = field.graph.handles.header[0]
    holder = await holdLock(field, 'node', entry)
    await killHolder(holder)

    const { value, error, ms } = searchFor(field, 7)

    expect(error).toBeUndefined()
    expect(value?.[0]?.docId).toBe('doc-7')
    expect(ms).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9)
    expect(ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
    expect(heldWordsOf(field)).toEqual([0, expect.any(Number), 0, 0, 0, 0])
  })

  it('answers at once while a reader that died still counts in the graph lock', async () => {
    const field = openField(DOCUMENTS)
    holder = await holdLock(field, 'graph')
    await killHolder(holder)

    const { value, error, ms } = searchFor(field, 11)

    expect(error).toBeUndefined()
    expect(value?.[0]?.docId).toBe('doc-11')
    expect(ms).toBeLessThan(DEADLINE_MS)
  })

  it('answers once the deadline drops a dead thread from the queue for the whole graph', async () => {
    const field = openField(DOCUMENTS)
    holder = await holdLock(field, 'graphWaiting')
    await killHolder(holder)

    const { value, error, ms } = searchFor(field, 23)

    expect(error).toBeUndefined()
    expect(value?.[0]?.docId).toBe('doc-23')
    expect(ms).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9)
    expect(ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
    expect(Atomics.load(field.graph.handles.header, 97)).toBe(0)
  })

  it('throws WORKER_TIMEOUT within the deadline while a dead thread holds the whole graph', async () => {
    const field = openField(DOCUMENTS)
    holder = await holdLock(field, 'graphAlone')
    await killHolder(holder)

    const { error, ms } = searchFor(field, 31)

    expect(isNarsilError(error) && error.code).toBe(ErrorCodes.WORKER_TIMEOUT)
    expect(ms).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9)
    expect(ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
  })

  it('answers at once and places a first vector once the deadline releases the entry lock of a thread that died', async () => {
    const field = openField(DOCUMENTS)
    holder = await holdLock(field, 'entry')
    await killHolder(holder)

    const search = searchFor(field, 43)
    expect(search.error).toBeUndefined()
    expect(search.value?.[0]?.docId).toBe('doc-43')
    expect(search.ms).toBeLessThan(DEADLINE_MS)

    const empty = openField(0)
    holder = await holdLock(empty, 'entry')
    await killHolder(holder)
    const placed = timed(() => empty.graph.insertOrdinal(ordinalOf(empty.store, DOCUMENTS)))

    expect(placed.error).toBeUndefined()
    expect(placed.ms).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9)
    expect(placed.ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
    expect(empty.graph.handles.header[0]).toBe(ordinalOf(empty.store, DOCUMENTS))
    expect(Atomics.load(empty.graph.handles.header, 128)).toBe(0)
    expect(heldWordsOf(empty)[5]).toBe(0)
  })

  it('throws WORKER_TIMEOUT within the deadline while a live thread keeps a node locked', async () => {
    const field = openField(DOCUMENTS)
    const entry = field.graph.handles.header[0]
    holder = await holdLock(field, 'node', entry)

    const { error, ms } = searchFor(field, 53)

    expect(isNarsilError(error) && error.code).toBe(ErrorCodes.WORKER_TIMEOUT)
    expect(ms).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9)
    expect(ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
  })
})
