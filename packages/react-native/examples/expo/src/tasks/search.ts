import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import {
  corpus,
  DIMENSION,
  HYBRID_DEPTH,
  HYBRID_EF_SEARCH,
  HYBRID_TERM,
  KEYWORD_TERMS,
  NEIGHBOURS,
  queryVectors,
  removedDuringSearch,
  WRITE_ROUNDS_DURING_SEARCH,
  writtenDuringSearch,
} from '../corpus'
import { upload } from '../harness'

export const SEARCH_INDEX = 'search'
export const SEARCH_SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const
const FULL_PRECISION_INDEX = 'search-full-precision'
const SCANNED_UNDER_WRITES_INDEX = 'search-scanned-under-writes'
const GRAPH_NEVER_BUILT_THRESHOLD = 1_000_000
const SEARCHED_INDEX_SNAPSHOT = 'searched-index.nrsl'
const KEYWORD_LIMIT = 10_000
const LATENCY_ROUNDS = 5
const GRAPH_SETTLE_TIMEOUT_MS = 120_000
const GRAPH_SETTLE_POLL_MS = 50

export interface RankedHit {
  id: string
  score: number
}

export interface SearchReport {
  insertMs: number
  openMs: number
  firstQueryAfterOpenMs: number
  keyword: Array<{ term: string; count: number; hits: RankedHit[] }>
  vector: Array<{ query: number; hits: RankedHit[]; depthHits: RankedHit[] }>
  hybrid: Array<{ query: number; hits: RankedHit[] }>
  fullPrecisionHybrid: Array<{ query: number; depthHits: RankedHit[]; hits: RankedHit[] }>
  underWrites: SearchUnderWritesReport
  latencyMs: { keyword: number[]; vector: number[]; hybrid: number[] }
  memory: unknown
}

export interface AcknowledgedWrite {
  kind: 'remove' | 'insert'
  ids: string[]
}

export interface QueryDuringWrites {
  query: number
  writesAcknowledgedBefore: number
  writesAcknowledgedAfter: number
  writesStartedAfter: number
  hits: RankedHit[]
}

interface WriteProgress {
  started: number
  finished: boolean
}

export interface SearchUnderWritesReport {
  writes: AcknowledgedWrite[]
  queries: QueryDuringWrites[]
  afterWrites: Array<{ query: number; hits: RankedHit[] }>
}

function ranked(hits: Array<{ id: string; score?: number }>): RankedHit[] {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

function directoryFor(run: number): string {
  return `search-${run}`
}

async function graphSettled(narsil: PhoneNarsil, indexName: string): Promise<void> {
  const deadline = performance.now() + GRAPH_SETTLE_TIMEOUT_MS
  for (;;) {
    const [field] = await narsil.vectorMaintenanceStatus(indexName)
    const settled =
      field !== undefined &&
      field.graphCount === 1 &&
      field.bufferSize === 0 &&
      !field.building &&
      !field.waitingForMemory &&
      !field.loadingFromFiles
    if (settled) return
    if (performance.now() > deadline) throw new Error(`The vector graph did not settle: ${JSON.stringify(field)}`)
    await new Promise(resolve => setTimeout(resolve, GRAPH_SETTLE_POLL_MS))
  }
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await work()
  return { value, ms: performance.now() - started }
}

async function measuredQueries(narsil: PhoneNarsil, vectors: number[][]): Promise<SearchReport['latencyMs']> {
  const latency: SearchReport['latencyMs'] = { keyword: [], vector: [], hybrid: [] }
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    for (const [index, value] of vectors.entries()) {
      const term = KEYWORD_TERMS[index % KEYWORD_TERMS.length] ?? HYBRID_TERM
      latency.keyword.push((await timed(() => narsil.query(SEARCH_INDEX, { term, limit: NEIGHBOURS }))).ms)
      const vector = { field: 'embedding', value }
      latency.vector.push(
        (await timed(() => narsil.query(SEARCH_INDEX, { mode: 'vector', vector, limit: NEIGHBOURS }))).ms,
      )
      latency.hybrid.push(
        (await timed(() => narsil.query(SEARCH_INDEX, { mode: 'hybrid', term, vector, limit: NEIGHBOURS }))).ms,
      )
    }
  }
  return latency
}

export type OpenEngine = (directory: string) => Promise<PhoneNarsil>

function openOnAppRuntime(directory: string): Promise<PhoneNarsil> {
  return createNarsil({ durability: { directory } })
}

export async function runSearchTask(open: OpenEngine = openOnAppRuntime): Promise<SearchReport> {
  const run = Date.now()
  const documents = corpus()
  const vectors = queryVectors()
  const first = await open(directoryFor(run))
  let insertMs: number
  try {
    await first.createIndex(SEARCH_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    const inserted = await timed(() => first.insertBatch(SEARCH_INDEX, documents))
    if (inserted.value.failed.length > 0) {
      throw new Error(`${inserted.value.failed.length} documents failed to insert`)
    }
    insertMs = inserted.ms
    await first.checkpoint(SEARCH_INDEX)
  } finally {
    await first.shutdown()
  }

  const opened = await timed(() => open(directoryFor(run)))
  const narsil = opened.value
  try {
    const firstQuery = await timed(() => narsil.query(SEARCH_INDEX, { term: HYBRID_TERM, limit: NEIGHBOURS }))
    await graphSettled(narsil, SEARCH_INDEX)
    const keyword: SearchReport['keyword'] = []
    for (const term of KEYWORD_TERMS) {
      const answer = await narsil.query(SEARCH_INDEX, { term, limit: KEYWORD_LIMIT })
      keyword.push({ term, count: answer.count, hits: ranked(answer.hits) })
    }
    const vector: SearchReport['vector'] = []
    const hybrid: SearchReport['hybrid'] = []
    for (const [index, value] of vectors.entries()) {
      const config = { field: 'embedding', value, efSearch: HYBRID_EF_SEARCH }
      const top = await narsil.query(SEARCH_INDEX, { mode: 'vector', vector: config, limit: NEIGHBOURS })
      const deep = await narsil.query(SEARCH_INDEX, { mode: 'vector', vector: config, limit: HYBRID_DEPTH })
      vector.push({ query: index, hits: ranked(top.hits), depthHits: ranked(deep.hits) })
      const fused = await narsil.query(SEARCH_INDEX, {
        mode: 'hybrid',
        term: HYBRID_TERM,
        vector: config,
        hybrid: { depth: HYBRID_DEPTH },
        limit: HYBRID_DEPTH,
      })
      hybrid.push({ query: index, hits: ranked(fused.hits) })
    }
    await upload(SEARCHED_INDEX_SNAPSHOT, await narsil.snapshot(SEARCH_INDEX))
    const latencyMs = await measuredQueries(narsil, vectors)
    const memory = await narsil.getMemoryStats()
    const fullPrecisionHybrid = await hybridOnFullPrecision(narsil, documents, vectors)
    const underWrites = await searchUnderWrites(narsil, documents, vectors)
    return {
      insertMs,
      openMs: opened.ms,
      firstQueryAfterOpenMs: firstQuery.ms,
      keyword,
      vector,
      hybrid,
      fullPrecisionHybrid,
      underWrites,
      latencyMs,
      memory,
    }
  } finally {
    await narsil.dropIndex(SCANNED_UNDER_WRITES_INDEX).catch(() => undefined)
    await narsil.dropIndex(FULL_PRECISION_INDEX).catch(() => undefined)
    await narsil.dropIndex(SEARCH_INDEX).catch(() => undefined)
    await narsil.shutdown()
  }
}

async function writeWhileSearching(
  narsil: PhoneNarsil,
  documents: ReturnType<typeof corpus>,
  writes: AcknowledgedWrite[],
  progress: WriteProgress,
): Promise<void> {
  for (let round = 0; round < WRITE_ROUNDS_DURING_SEARCH; round++) {
    const removed = removedDuringSearch(documents, round)
    progress.started++
    const removal = await narsil.removeBatch(SCANNED_UNDER_WRITES_INDEX, removed)
    if (removal.failed.length > 0) throw new Error(`${removal.failed.length} documents failed to remove`)
    writes.push({ kind: 'remove', ids: removed })
    const written = writtenDuringSearch(round)
    progress.started++
    const insertion = await narsil.insertBatch(SCANNED_UNDER_WRITES_INDEX, written)
    if (insertion.failed.length > 0) throw new Error(`${insertion.failed.length} documents failed to insert`)
    writes.push({ kind: 'insert', ids: written.map(document => document.id) })
  }
}

async function queryWhileWriting(
  narsil: PhoneNarsil,
  vectors: number[][],
  writes: readonly AcknowledgedWrite[],
  progress: WriteProgress,
): Promise<QueryDuringWrites[]> {
  const answers: QueryDuringWrites[] = []
  for (let asked = 0; !progress.finished || asked < vectors.length; asked++) {
    const query = asked % vectors.length
    const writesAcknowledgedBefore = writes.length
    const answer = await narsil.query(SCANNED_UNDER_WRITES_INDEX, {
      mode: 'vector',
      vector: { field: 'embedding', value: vectors[query] ?? [] },
      limit: NEIGHBOURS,
    })
    answers.push({
      query,
      writesAcknowledgedBefore,
      writesAcknowledgedAfter: writes.length,
      writesStartedAfter: progress.started,
      hits: ranked(answer.hits),
    })
  }
  return answers
}

async function searchUnderWrites(
  narsil: PhoneNarsil,
  documents: ReturnType<typeof corpus>,
  vectors: number[][],
): Promise<SearchUnderWritesReport> {
  await narsil.createIndex(SCANNED_UNDER_WRITES_INDEX, {
    schema: SEARCH_SCHEMA,
    language: 'english',
    vectorPromotion: { threshold: GRAPH_NEVER_BUILT_THRESHOLD, quantization: 'none' },
  })
  const inserted = await narsil.insertBatch(SCANNED_UNDER_WRITES_INDEX, documents)
  if (inserted.failed.length > 0) {
    throw new Error(`${inserted.failed.length} documents failed to insert into the index scanned under writes`)
  }
  const writes: AcknowledgedWrite[] = []
  const progress: WriteProgress = { started: 0, finished: false }
  const writer = writeWhileSearching(narsil, documents, writes, progress).finally(() => {
    progress.finished = true
  })
  const [, queries] = await Promise.all([writer, queryWhileWriting(narsil, vectors, writes, progress)])
  const afterWrites: SearchUnderWritesReport['afterWrites'] = []
  for (const [query, value] of vectors.entries()) {
    const answer = await narsil.query(SCANNED_UNDER_WRITES_INDEX, {
      mode: 'vector',
      vector: { field: 'embedding', value },
      limit: NEIGHBOURS,
    })
    afterWrites.push({ query, hits: ranked(answer.hits) })
  }
  return { writes, queries, afterWrites }
}

async function hybridOnFullPrecision(
  narsil: PhoneNarsil,
  documents: ReturnType<typeof corpus>,
  vectors: number[][],
): Promise<SearchReport['fullPrecisionHybrid']> {
  await narsil.createIndex(FULL_PRECISION_INDEX, {
    schema: SEARCH_SCHEMA,
    language: 'english',
    vectorPromotion: { quantization: 'none' },
  })
  const inserted = await narsil.insertBatch(FULL_PRECISION_INDEX, documents)
  if (inserted.failed.length > 0) {
    throw new Error(`${inserted.failed.length} documents failed to insert into the full-precision index`)
  }
  await graphSettled(narsil, FULL_PRECISION_INDEX)
  const answers: SearchReport['fullPrecisionHybrid'] = []
  for (const [index, value] of vectors.entries()) {
    const config = { field: 'embedding', value, efSearch: HYBRID_EF_SEARCH }
    const deep = await narsil.query(FULL_PRECISION_INDEX, { mode: 'vector', vector: config, limit: HYBRID_DEPTH })
    const fused = await narsil.query(FULL_PRECISION_INDEX, {
      mode: 'hybrid',
      term: HYBRID_TERM,
      vector: config,
      hybrid: { depth: HYBRID_DEPTH },
      limit: HYBRID_DEPTH,
    })
    answers.push({ query: index, depthHits: ranked(deep.hits), hits: ranked(fused.hits) })
  }
  return answers
}
