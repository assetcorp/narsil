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

  for (const query of queries.slice(0, 10)) {
    await engine.search(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.search(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

export async function measureSearchTermMatchAll(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  if (!engine.searchTermMatchAll) return []
  await engine.create()
  await engine.insert(documents)

  for (const query of queries.slice(0, 10)) {
    await engine.searchTermMatchAll(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.searchTermMatchAll(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

export async function measureFilteredSearch(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  if (!engine.searchWithFilter) return []
  await engine.create()
  await engine.insert(documents)

  for (const query of queries.slice(0, 10)) {
    await engine.searchWithFilter(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.searchWithFilter(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

export async function measureVectorSearch(
  engine: VectorSearchEngine,
  documents: VectorBenchDocument[],
  queryVectors: number[][],
): Promise<number[]> {
  await engine.create()
  await engine.insert(documents)

  for (const qv of queryVectors.slice(0, 10)) {
    await engine.searchVector(qv, VECTOR_K)
  }

  const times: number[] = []
  for (const qv of queryVectors) {
    const start = performance.now()
    await engine.searchVector(qv, VECTOR_K)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
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

  const searchTimes: number[] = []
  for (const q of queries.slice(0, 50)) {
    const s = performance.now()
    await engine.search(q)
    searchTimes.push(performance.now() - s)
  }

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
    searchAfterRemoveMedianMs: median(searchTimes),
    reinsertDocsPerSec: Math.round(removeCount / (reinsertMs / 1000)),
  }
}
