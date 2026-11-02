import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { corpus, DIMENSION, HYBRID_TERM, KEYWORD_TERMS, NEIGHBOURS, queryVectors } from '../corpus'

export const SEARCH_INDEX = 'search'
export const SEARCH_SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const
export const HYBRID_DEPTH = 100
const HYBRID_EF_SEARCH = 200
const KEYWORD_LIMIT = 10_000
const LATENCY_ROUNDS = 5

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
  hybrid: Array<{ query: number; term: string; keywordHits: RankedHit[]; hits: RankedHit[] }>
  latencyMs: { keyword: number[]; vector: number[]; hybrid: number[] }
  memory: unknown
}

function ranked(hits: Array<{ id: string; score?: number }>): RankedHit[] {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

function directoryFor(run: number): string {
  return `search-${run}`
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

export async function runSearchTask(): Promise<SearchReport> {
  const run = Date.now()
  const documents = corpus()
  const vectors = queryVectors()
  const first = await createNarsil({ durability: { directory: directoryFor(run) } })
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

  const opened = await timed(() => createNarsil({ durability: { directory: directoryFor(run) } }))
  const narsil = opened.value
  try {
    const firstQuery = await timed(() => narsil.query(SEARCH_INDEX, { term: HYBRID_TERM, limit: NEIGHBOURS }))
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
      const keywordAnswer = await narsil.query(SEARCH_INDEX, { term: HYBRID_TERM, limit: HYBRID_DEPTH })
      const fused = await narsil.query(SEARCH_INDEX, {
        mode: 'hybrid',
        term: HYBRID_TERM,
        vector: config,
        hybrid: { depth: HYBRID_DEPTH },
        limit: HYBRID_DEPTH,
      })
      hybrid.push({
        query: index,
        term: HYBRID_TERM,
        keywordHits: ranked(keywordAnswer.hits),
        hits: ranked(fused.hits),
      })
    }
    const latencyMs = await measuredQueries(narsil, vectors)
    const memory = await narsil.getMemoryStats()
    return {
      insertMs,
      openMs: opened.ms,
      firstQueryAfterOpenMs: firstQuery.ms,
      keyword,
      vector,
      hybrid,
      latencyMs,
      memory,
    }
  } finally {
    await narsil.dropIndex(SEARCH_INDEX).catch(() => undefined)
    await narsil.shutdown()
  }
}
