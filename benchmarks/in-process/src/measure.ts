import { recallAtK } from './data/knn'
import { median, tryGc } from './stats'
import type {
  BenchDocument,
  MutationResult,
  SearchEngine,
  SerializableEngine,
  SerializationResult,
  VectorBenchDocument,
  VectorSearchEngine,
} from './types'

const INSERT_ITERATIONS = 5
const WARMUP_ITERATIONS = 2
const VECTOR_K = 10

export const SEARCH_WARMUP_ROUNDS = 2
export const SEARCH_REPEAT_ROUNDS = 5
const MUTATION_SEARCH_QUERY_COUNT = 50

function nowNs(): bigint {
  return process.hrtime.bigint()
}

// Mirrors the server suite's latency methodology: discard `warmupRounds` full
// passes over every item, then time each item individually across `repeatRounds`
// more passes and pool the samples. Per-item nanosecond timing keeps sub-millisecond
// queries measurable, and pooling repeatRounds*items samples makes the reported
// percentiles stable where a single pass per query left the tail dominated by noise.
async function measureLatencyMs<T>(
  items: readonly T[],
  runOne: (item: T) => Promise<unknown>,
  warmupRounds = SEARCH_WARMUP_ROUNDS,
  repeatRounds = SEARCH_REPEAT_ROUNDS,
): Promise<number[]> {
  for (let round = 0; round < warmupRounds; round++) {
    for (const item of items) await runOne(item)
  }
  const samples: number[] = []
  for (let round = 0; round < repeatRounds; round++) {
    for (const item of items) {
      const start = nowNs()
      await runOne(item)
      samples.push(Number(nowNs() - start) / 1_000_000)
    }
  }
  return samples
}

export async function measureInsert<T>(
  engine: { create(): Promise<void>; insert(docs: T[]): Promise<void>; teardown(): Promise<void> },
  documents: T[],
): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < INSERT_ITERATIONS + WARMUP_ITERATIONS; i++) {
    await engine.create()
    const start = performance.now()
    await engine.insert(documents)
    const elapsed = performance.now() - start
    await engine.teardown()
    if (i >= WARMUP_ITERATIONS) times.push(elapsed)
  }
  return times
}

export async function measureSearch(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  await engine.create()
  await engine.insert(documents)
  const samples = await measureLatencyMs(queries, q => engine.search(q))
  await engine.teardown()
  return samples
}

export async function measureSearchTermMatchAll(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  const runOne = engine.searchTermMatchAll
  if (!runOne) return []
  await engine.create()
  await engine.insert(documents)
  const samples = await measureLatencyMs(queries, q => runOne.call(engine, q))
  await engine.teardown()
  return samples
}

export async function measureFilteredSearch(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  const runOne = engine.searchWithFilter
  if (!runOne) return []
  await engine.create()
  await engine.insert(documents)
  const samples = await measureLatencyMs(queries, q => runOne.call(engine, q))
  await engine.teardown()
  return samples
}

export async function measureVectorSearch(
  engine: VectorSearchEngine,
  documents: VectorBenchDocument[],
  queryVectors: number[][],
): Promise<number[]> {
  await engine.create()
  await engine.insert(documents)
  const samples = await measureLatencyMs(queryVectors, qv => engine.searchVector(qv, VECTOR_K))
  await engine.teardown()
  return samples
}

export async function measureVectorRecall(
  engine: VectorSearchEngine,
  documents: VectorBenchDocument[],
  queryVectors: number[][],
  groundTruth: string[][],
  k: number,
): Promise<number> {
  await engine.create()
  await engine.insert(documents)
  let sum = 0
  for (let i = 0; i < queryVectors.length; i++) {
    const ids = await engine.searchVectorWithIds(queryVectors[i], k)
    sum += recallAtK(ids, groundTruth[i])
  }
  await engine.teardown()
  return queryVectors.length > 0 ? sum / queryVectors.length : 0
}

export async function measureMemory<T>(
  engine: { create(): Promise<void>; insert(docs: T[]): Promise<void>; teardown(): Promise<void> },
  documents: T[],
): Promise<number> {
  await engine.teardown()
  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 100))
  const baseline = process.memoryUsage().heapUsed

  await engine.create()
  await engine.insert(documents)
  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 100))
  const after = process.memoryUsage().heapUsed

  await engine.teardown()
  return Math.max(0, after - baseline)
}

export async function measureSerialization(
  engine: SerializableEngine,
  documents: BenchDocument[],
  query: string,
): Promise<SerializationResult> {
  await engine.create()
  await engine.insert(documents)

  const serStart = performance.now()
  const serialized = await engine.serialize()
  const serializeMs = performance.now() - serStart

  const serializedBytes =
    typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : serialized.byteLength

  const deserStart = performance.now()
  await engine.deserializeAndSearch(serialized, query)
  const deserializeAndSearchMs = performance.now() - deserStart

  await engine.teardown()
  return { serializeMs, serializedBytes, deserializeAndSearchMs }
}

export async function measureMutations(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<MutationResult | null> {
  if (!engine.remove && !engine.removeBatch) return null
  await engine.create()
  await engine.insert(documents)

  const removeCount = Math.floor(documents.length * 0.02)
  const idsToRemove = (engine.insertedIds ?? []).slice(0, removeCount)
  if (idsToRemove.length === 0) {
    await engine.teardown()
    return null
  }

  const removeStart = performance.now()
  if (engine.removeBatch) {
    await engine.removeBatch(idsToRemove)
  } else if (engine.remove) {
    for (const id of idsToRemove) {
      await engine.remove(id)
    }
  }
  const removeMs = performance.now() - removeStart
  const removeDocsPerSec = Math.round(removeCount / (removeMs / 1000))

  const searchSamples = await measureLatencyMs(queries.slice(0, MUTATION_SEARCH_QUERY_COUNT), q => engine.search(q))

  const reinsertDocs = documents.slice(documents.length - removeCount).map((d, i) => ({
    ...d,
    id: `reinsertion-${i}`,
    title: `${d.title} reinserted`,
  }))
  const reinsertStart = performance.now()
  await engine.insert(reinsertDocs)
  const reinsertMs = performance.now() - reinsertStart

  await engine.teardown()

  return {
    removeDocsPerSec,
    removeMedianMs: removeMs,
    searchAfterRemoveMedianMs: median(searchSamples),
    reinsertDocsPerSec: Math.round(removeCount / (reinsertMs / 1000)),
  }
}
