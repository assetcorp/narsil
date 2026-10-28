import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { postJson, startTestServer, type TestServer } from '../helpers'

const VECTOR_DIMENSION = 1536
const VECTOR_QUANTIZATION = 'osq8'
const BASE_DOCUMENTS = 1_200
const INSERT_BATCH_SIZE = 300
const ROUNDS = 6
const FRESH_PER_ROUND = 4
const REPEATS_PER_CHECK = 3
const SIMILARITY_FLOOR = 0.5
const SIMILARITY_LIMIT = 10
const EXHAUSTIVE_EF_SEARCH = 1_000
const COPY_LOAD_TIMEOUT_MS = 120_000
const CONCURRENT_STEPS = 40
const CONCURRENT_SEARCHERS = 6
const INDEX = 'clips'
const FILTERED_GROUP = 'a'

interface ClipDocument {
  id: string
  title: string
  group: string
  embedding: number[]
}

interface Acknowledged {
  id: string
  embedding: number[]
  present: boolean
}

interface SearchBody {
  hits: Array<{ id: string }>
  count: number
}

function seededValues(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    values[i] = Math.fround(state / 2_147_483_648 - 1)
  }
  return values
}

function clip(i: number, seed = i + 1): ClipDocument {
  return {
    id: `clip-${i}`,
    title: `clip number ${i} tag${i}x`,
    group: i % 2 === 0 ? FILTERED_GROUP : 'b',
    embedding: seededValues(seed, VECTOR_DIMENSION),
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
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

function vectorQuery(embedding: number[], extra: Partial<QueryParams> = {}): QueryParams {
  return {
    mode: 'vector',
    vector: { field: 'embedding', value: embedding, efSearch: EXHAUSTIVE_EF_SEARCH },
    document: false,
    limit: 1,
    ...extra,
  }
}

function floorQuery(embedding: number[]): QueryParams {
  return vectorQuery(embedding, {
    vector: { field: 'embedding', value: embedding, efSearch: EXHAUSTIVE_EF_SEARCH, similarity: SIMILARITY_FLOOR },
    limit: SIMILARITY_LIMIT,
  })
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

describe.skipIf(!built)('vector searches that request threads answer right after a write', () => {
  let srv: TestServer
  let mainQueries = 0
  let mainQuery: Narsil['query']
  const live = new Map<string, ClipDocument>()

  beforeEach(async () => {
    live.clear()
    srv = await startTestServer(undefined, { workers: { count: 2 } }, async prepared => {
      mainQueries = 0
      mainQuery = prepared.query.bind(prepared)
      prepared.query = (indexName, params) => {
        mainQueries += 1
        return mainQuery(indexName, params)
      }
    })
  })

  afterEach(async () => {
    await srv.stop()
  })

  function batchBody(action: 'insert' | 'update' | 'delete', documents: ClipDocument[]): Record<string, unknown> {
    const options = { wait: true }
    if (action === 'insert') return { action, documents, options }
    if (action === 'delete') return { action, docIds: documents.map(document => document.id), options }
    return { action, updates: documents.map(document => ({ docId: document.id, document })), options }
  }

  async function write(action: 'insert' | 'update' | 'delete', documents: ClipDocument[]): Promise<void> {
    const body = batchBody(action, documents)
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, body)
    expect(written.status, JSON.stringify(written.body)).toBe(200)
    expect(written.body.failed).toEqual([])
    for (const document of documents) {
      if (action === 'delete') live.delete(document.id)
      else live.set(document.id, document)
    }
  }

  async function search(params: QueryParams): Promise<SearchBody> {
    const response = await postJson<SearchBody>(srv.base, `/indexes/${INDEX}/search`, params)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return response.body
  }

  function oracleAbove(embedding: number[], floor: number): string[] {
    const ids: string[] = []
    for (const document of live.values()) {
      if (cosine(embedding, document.embedding) >= floor) ids.push(document.id)
    }
    return ids.sort()
  }

  function groupSize(group: string): number {
    let size = 0
    for (const document of live.values()) if (document.group === group) size += 1
    return size
  }

  async function waitForVectorSearchesOnThreads(probe: number[]): Promise<void> {
    const deadline = Date.now() + COPY_LOAD_TIMEOUT_MS
    for (;;) {
      const before = mainQueries
      await Promise.all(Array.from({ length: 8 }, () => search(vectorQuery(probe))))
      if (mainQueries === before) return
      if (Date.now() > deadline) throw new Error('The request threads never came to answer vector searches')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async function expectEverywhere(params: QueryParams, check: (answer: SearchBody) => void): Promise<number> {
    const before = mainQueries
    const answers = await Promise.all(Array.from({ length: REPEATS_PER_CHECK }, () => search(params)))
    const relayed = mainQueries - before
    for (const answer of answers) check(answer)
    const onMain = await mainQuery(INDEX, params)
    for (const answer of answers) {
      expect(answer.count).toBe(onMain.count)
      expect(answer.hits.map(hit => hit.id)).toEqual(onMain.hits.map(hit => hit.id))
    }
    return REPEATS_PER_CHECK - relayed
  }

  async function checkFresh(fresh: ClipDocument): Promise<number> {
    const answered = await Promise.all([
      expectEverywhere(vectorQuery(fresh.embedding), answer => {
        expect(answer.hits.map(hit => hit.id)).toEqual([fresh.id])
        expect(answer.count).toBe(live.size)
      }),
      expectEverywhere(floorQuery(fresh.embedding), answer => {
        const expected = oracleAbove(fresh.embedding, SIMILARITY_FLOOR)
        expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected)
        expect(answer.count).toBe(expected.length)
      }),
      expectEverywhere(
        vectorQuery(fresh.embedding, { filters: { fields: { group: { eq: fresh.group } } } }),
        answer => {
          expect(answer.hits.map(hit => hit.id)).toEqual([fresh.id])
          expect(answer.count).toBe(groupSize(fresh.group))
        },
      ),
      expectEverywhere(vectorQuery(fresh.embedding, { mode: 'hybrid', term: `tag${fresh.id.slice(5)}x` }), answer => {
        expect(answer.hits.map(hit => hit.id)).toEqual([fresh.id])
      }),
    ])
    return answered.reduce((total, onThreads) => total + onThreads, 0)
  }

  async function checkReembedded(previous: ClipDocument, current: ClipDocument): Promise<number> {
    const answered = await Promise.all([
      expectEverywhere(vectorQuery(current.embedding), answer => {
        expect(answer.hits.map(hit => hit.id)).toEqual([current.id])
      }),
      expectEverywhere(floorQuery(previous.embedding), answer => {
        const expected = oracleAbove(previous.embedding, SIMILARITY_FLOOR)
        expect(expected).not.toContain(current.id)
        expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected)
        expect(answer.count).toBe(expected.length)
      }),
    ])
    return answered.reduce((total, onThreads) => total + onThreads, 0)
  }

  async function createLoadedIndex(): Promise<ClipDocument[]> {
    const created = await postJson(srv.base, '/indexes', {
      name: INDEX,
      config: {
        schema: { title: 'string', group: 'enum', embedding: `vector[${VECTOR_DIMENSION}]` },
        vectorPromotion: { quantization: VECTOR_QUANTIZATION },
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const base = Array.from({ length: BASE_DOCUMENTS }, (_, i) => clip(i))
    for (let start = 0; start < base.length; start += INSERT_BATCH_SIZE) {
      await write('insert', base.slice(start, start + INSERT_BATCH_SIZE))
    }
    await waitForVectorSearchesOnThreads(base[0].embedding)
    return base
  }

  async function checkAcknowledged(expectation: Acknowledged): Promise<number> {
    const before = mainQueries
    if (expectation.present) {
      const answer = await search(vectorQuery(expectation.embedding))
      expect(
        answer.hits.map(hit => hit.id),
        `the vector of ${expectation.id} after its write`,
      ).toEqual([expectation.id])
    } else {
      const answer = await search(floorQuery(expectation.embedding))
      expect(
        answer.hits.map(hit => hit.id),
        `the vector that ${expectation.id} gave up`,
      ).not.toContain(expectation.id)
    }
    return mainQueries === before ? 1 : 0
  }

  it('never loses an acknowledged vector or brings back a removed one while writes and searches overlap', async () => {
    const base = await createLoadedIndex()
    const acknowledged: Acknowledged[] = []
    let writing = true
    const writer = (async () => {
      try {
        for (let step = 0; step < CONCURRENT_STEPS; step++) {
          const fresh = { ...clip(BASE_DOCUMENTS + step), group: FILTERED_GROUP }
          await write('insert', [fresh])
          acknowledged.push({ id: fresh.id, embedding: fresh.embedding, present: true })

          const previous = base[step * 2]
          const current = { ...previous, embedding: seededValues(2_000_003 + step, VECTOR_DIMENSION) }
          await write('update', [current])
          acknowledged.push({ id: previous.id, embedding: previous.embedding, present: false })
          acknowledged.push({ id: current.id, embedding: current.embedding, present: true })

          const removed = base[step * 2 + 1]
          await write('delete', [removed])
          acknowledged.push({ id: removed.id, embedding: removed.embedding, present: false })
        }
      } finally {
        writing = false
      }
    })()

    let answeredOnThreads = 0
    const searchers = Array.from({ length: CONCURRENT_SEARCHERS }, async (_, searcher) => {
      for (let turn = searcher; writing; turn += CONCURRENT_SEARCHERS) {
        const known = acknowledged.length
        if (known === 0) {
          await new Promise(resolve => setTimeout(resolve, 1))
          continue
        }
        answeredOnThreads += await checkAcknowledged(acknowledged[known - 1 - (turn % Math.min(known, 8))])
      }
    })
    await Promise.all([writer, ...searchers])
    for (const expectation of acknowledged) answeredOnThreads += await checkAcknowledged(expectation)
    expect(answeredOnThreads).toBeGreaterThan(0)
  }, 600_000)

  it('finds every vector written with wait, and matches main, whichever thread answers', async () => {
    const base = await createLoadedIndex()

    let answeredOnThreads = 0
    for (let round = 0; round < ROUNDS; round++) {
      const fresh = Array.from({ length: FRESH_PER_ROUND }, (_, k) => {
        const i = BASE_DOCUMENTS + round * FRESH_PER_ROUND + k
        return { ...clip(i), group: FILTERED_GROUP }
      })
      await write('insert', fresh)
      for (const document of fresh) answeredOnThreads += await checkFresh(document)

      const previous = base[round * 7]
      const current = { ...previous, embedding: seededValues(1_000_003 + round, VECTOR_DIMENSION) }
      await write('update', [current])
      answeredOnThreads += await checkReembedded(previous, current)
    }

    expect(answeredOnThreads).toBeGreaterThan(0)
  }, 600_000)
})
