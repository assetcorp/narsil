import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { postJson, startTestServer, type TestServer } from '../helpers'

const INDEX = 'clips'
const VECTOR_DIMENSION = 64
const BASE_DOCUMENTS = 1_500
const INSERT_BATCH_SIZE = 500
const WRITER_STEPS = 400
const UPDATES_PER_STEP = 8
const CONCURRENT_SEARCHERS = 8
const HITS_PER_SEARCH = 20
const SCORE_TOLERANCE = 1e-5
const COPY_LOAD_TIMEOUT_MS = 120_000
const SEARCHERS_KEEP_GOING_MS = 30_000

interface ClipDocument {
  id: string
  title: string
  group: string
  seed: number
  embedding: number[]
}

interface SearchHit {
  id: string
  score?: number
  document?: { embedding?: number[]; seed?: number }
}

interface SearchBody {
  hits: SearchHit[]
  groups?: Array<{ hits: SearchHit[] }>
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

function clip(i: number, seed = i + 1): ClipDocument {
  return {
    id: `clip-${i}`,
    title: `clip number ${i}`,
    group: i % 2 === 0 ? 'even' : 'odd',
    seed,
    embedding: seededValues(seed, VECTOR_DIMENSION),
  }
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

describe.skipIf(!built)('vector scores that request threads answer while writes run', () => {
  let srv: TestServer
  let mainQueries = 0
  let mainQuery: Narsil['query']

  beforeEach(async () => {
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

  async function write(action: 'insert' | 'update', documents: ClipDocument[]): Promise<void> {
    const options = { wait: true }
    const body =
      action === 'insert'
        ? { action, documents, options }
        : { action, updates: documents.map(document => ({ docId: document.id, document })), options }
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, body)
    expect(written.status, JSON.stringify(written.body)).toBe(200)
    expect(written.body.failed).toEqual([])
  }

  async function search(params: QueryParams): Promise<SearchBody> {
    const response = await postJson<SearchBody>(srv.base, `/indexes/${INDEX}/search`, params)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return response.body
  }

  function vectorQuery(embedding: number[], filtered: boolean): QueryParams {
    return {
      mode: 'vector',
      vector: { field: 'embedding', value: embedding },
      limit: HITS_PER_SEARCH,
      ...(filtered ? { filters: { fields: { group: { eq: 'even' } } } } : {}),
    }
  }

  async function waitForVectorSearchesOnThreads(probe: number[]): Promise<void> {
    const deadline = Date.now() + COPY_LOAD_TIMEOUT_MS
    for (;;) {
      const before = mainQueries
      await Promise.all(Array.from({ length: 8 }, () => search(vectorQuery(probe, false))))
      if (mainQueries === before) return
      if (Date.now() > deadline) throw new Error('The request threads never came to answer vector searches')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('pairs every score with the cosine of the vector that the hit returns', async () => {
    const created = await postJson(srv.base, '/indexes', {
      name: INDEX,
      config: {
        schema: { title: 'string', group: 'enum', seed: 'number', embedding: `vector[${VECTOR_DIMENSION}]` },
        vectorPromotion: { quantization: 'none' },
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const base = Array.from({ length: BASE_DOCUMENTS }, (_, i) => clip(i))
    for (let start = 0; start < base.length; start += INSERT_BATCH_SIZE) {
      await write('insert', base.slice(start, start + INSERT_BATCH_SIZE))
    }
    await waitForVectorSearchesOnThreads(base[0].embedding)

    let writing = true
    const writer = (async () => {
      try {
        for (let step = 0; step < WRITER_STEPS; step++) {
          const updates = Array.from({ length: UPDATES_PER_STEP }, (_, k) => {
            const i = (step * UPDATES_PER_STEP + k) % BASE_DOCUMENTS
            return clip(i, 3_000_017 + step * UPDATES_PER_STEP + k)
          })
          await write('update', updates)
        }
      } finally {
        writing = false
      }
    })()

    let checked = 0
    let answeredOnThreads = 0
    const mismatches: string[] = []
    const stopAt = Date.now() + SEARCHERS_KEEP_GOING_MS
    const searchers = Array.from({ length: CONCURRENT_SEARCHERS }, async (_, searcher) => {
      for (let turn = searcher; writing && Date.now() < stopAt; turn += CONCURRENT_SEARCHERS) {
        const query = seededValues(7_000_001 + turn, VECTOR_DIMENSION)
        const before = mainQueries
        const answer = await search({
          ...vectorQuery(query, turn % 3 === 0),
          group: { fields: ['group'], maxPerGroup: HITS_PER_SEARCH },
          highlight: { fields: ['title'] },
        })
        if (mainQueries === before) answeredOnThreads += 1
        expect(answer.groups?.length).toBeGreaterThan(0)
        const hits = [...answer.hits, ...(answer.groups ?? []).flatMap(group => group.hits)]
        for (const hit of hits) {
          const embedding = hit.document?.embedding
          expect(embedding, `hit ${hit.id} returned no vector`).toBeDefined()
          if (embedding === undefined) continue
          const gap = Math.abs((hit.score ?? Number.NaN) - cosine(query, embedding))
          if (!(gap <= SCORE_TOLERANCE)) mismatches.push(`${hit.id} scored ${hit.score} for a vector at ${gap} away`)
          const seed = hit.document?.seed
          const expectedVector = seed === undefined ? undefined : seededValues(seed, VECTOR_DIMENSION)
          if (expectedVector === undefined || embedding.some((value, at) => value !== expectedVector[at])) {
            mismatches.push(`${hit.id} returned a vector from a different document version`)
          }
          checked += 1
        }
      }
    })
    await Promise.all([writer, ...searchers])

    expect(mismatches).toEqual([])
    expect(checked).toBeGreaterThan(0)
    expect(answeredOnThreads).toBeGreaterThan(0)
  }, 600_000)
})
