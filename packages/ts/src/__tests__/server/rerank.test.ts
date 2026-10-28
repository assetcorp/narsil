import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil } from '../../narsil'
import { createServer } from '../../server'
import type { QueryParams } from '../../types/search'
import { type CorpusDocument, corpus, corpusIndex, stored } from '../rerank/corpus'
import { oracleRerank, overlapScore, type RankedHit, recordingReranker, rerankTextOf } from '../rerank/oracle'
import { postJson, startTestServer, type TestServer } from './helpers'

const INDEX = 'docs'
const built = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const schemaOnly = { schema: corpusIndex.schema, language: 'english' }

interface ErrorBody {
  error: { code: string; message: string }
}

async function failureOf(promise: Promise<unknown>): Promise<NarsilError> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(outcome).toBeInstanceOf(NarsilError)
  return outcome as NarsilError
}

async function seeded(size: number, workers: boolean): Promise<{ server: TestServer; documents: CorpusDocument[] }> {
  const documents = corpus(size, 31)
  const server = await startTestServer(
    {
      rerankAdapters: {
        overlap: recordingReranker(),
        broken: {
          async rerank() {
            throw new Error('model offline')
          },
        },
      },
      limits: { maxRerankWindow: 40 },
    },
    workers ? { workers: { count: 2 } } : { workers: { enabled: false } },
    async engine => {
      await engine.createIndex(INDEX, { ...schemaOnly, schema: { ...corpusIndex.schema, embedding: 'vector[3]' } })
      await engine.insertBatch(
        INDEX,
        documents.map(document => ({ ...stored(document), id: document.id })),
      )
    },
  )
  return { server, documents }
}

async function oracleOrder(
  client: NarsilClient,
  documents: CorpusDocument[],
  base: QueryParams,
  window: number,
  query: string,
  fields: string[],
): Promise<RankedHit[]> {
  const byId = new Map(documents.map(document => [document.id, document]))
  const first = (await client.query(INDEX, { ...base, limit: 10_000 })).hits.map(hit => ({
    id: hit.id,
    score: hit.score ?? 0,
  }))
  const scores = first
    .slice(0, window)
    .map(hit => overlapScore(query, rerankTextOf(stored(byId.get(hit.id) as CorpusDocument), fields)))
  return oracleRerank(first, window, scores)
}

async function walk(client: NarsilClient, params: QueryParams, limit: number): Promise<RankedHit[]> {
  const seen: RankedHit[] = []
  let cursor: string | undefined
  for (let page = 0; page < 500; page++) {
    const result = await client.query(INDEX, { ...params, limit, searchAfter: cursor })
    seen.push(...result.hits.map(hit => ({ id: hit.id, score: hit.score ?? 0 })))
    cursor = result.cursor
    if (cursor === undefined) return seen
  }
  throw new Error('the cursor never ran out')
}

function expectSameOrder(actual: RankedHit[], expected: RankedHit[]): void {
  expect(actual.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
  for (const [i, hit] of actual.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 9)
}

describe('reranking over HTTP with the published client', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('returns the oracle order on every cursor page and keeps the count of the query without rerank', async () => {
    const setup = await seeded(150, false)
    server = setup.server
    const client = createNarsilClient({ url: server.base })
    const base: QueryParams = { term: 'harbor cedar river', termMatch: 'any' }
    const rerank = { adapter: 'overlap', fields: ['title', 'tags', 'summary'], window: 25 }

    const expected = await oracleOrder(client, setup.documents, base, 25, 'harbor cedar river', rerank.fields)
    const walked = await walk(client, { ...base, rerank }, 7)
    const plain = await client.query(INDEX, { ...base, limit: 1 })
    const reranked = await client.query(INDEX, { ...base, limit: 1, rerank })

    expectSameOrder(walked, expected)
    expect(reranked.count).toBe(plain.count)
  })

  it('answers a missing adapter with 400, a failing one with 503, and a window past the server limit with 400', async () => {
    server = (await seeded(30, false)).server
    const client = createNarsilClient({ url: server.base })

    const missing = await failureOf(
      client.query(INDEX, { term: 'river', rerank: { adapter: 'none', fields: ['title'] } }),
    )
    const broken = await failureOf(
      client.query(INDEX, { term: 'river', rerank: { adapter: 'broken', fields: ['title'] } }),
    )
    const tooWide = await postJson<ErrorBody>(server.base, `/indexes/${INDEX}/search`, {
      term: 'river',
      rerank: { adapter: 'overlap', fields: ['title'], window: 41 },
    })

    expect([missing.code, missing.details.status]).toEqual([ErrorCodes.RERANK_CONFIG_INVALID, 400])
    expect([broken.code, broken.details.status]).toEqual([ErrorCodes.RERANK_FAILED, 503])
    expect(tooWide.status).toBe(400)
    expect(tooWide.body.error.message).toContain('rerank.window')
  })

  it.each<[string, unknown]>([
    ['a string', 'overlap'],
    ['an array', ['overlap']],
    ['fields as an object', { adapter: 'overlap', fields: { title: true } }],
    ['a window written as text', { adapter: 'overlap', fields: ['title'], window: '10' }],
    ['a query that is not text', { adapter: 'overlap', fields: ['title'], query: 42 }],
  ])('answers 400 for a rerank given as %s', async (_label, rerank) => {
    server = (await seeded(30, false)).server
    const reply = await postJson<ErrorBody>(server.base, `/indexes/${INDEX}/search`, { term: 'river', rerank })
    expect(reply.status).toBe(400)
    expect(reply.body.error.code).toBe(ErrorCodes.RERANK_CONFIG_INVALID)
  })

  it.each([
    [{ maxRerankWindow: 0 }, undefined],
    [{ maxRerankWindow: 1_001 }, undefined],
    [{ maxRerankWindow: 2.5 }, undefined],
    [{ maxRerankWindow: 60 }, 50],
  ])('refuses the server limits %j over an engine window of %s', async (limits, engineWindow) => {
    const engine = await createNarsil({ workers: { enabled: false }, maxRerankWindow: engineWindow })
    try {
      expect(() => createServer(engine, { host: '127.0.0.1', port: 0, limits })).toThrow(
        expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
      )
    } finally {
      await engine.shutdown()
    }
  })
})

describe.skipIf(!built)('reranking on request threads that answer from worker copies', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('returns the oracle order from the main thread and the request threads alike', async () => {
    const setup = await seeded(1_200, true)
    server = setup.server
    expect(server.server.requestThreadCount).toBeGreaterThan(0)
    const client = createNarsilClient({ url: server.base })
    const base: QueryParams = { term: 'storm quiet', termMatch: 'all' }
    const rerank = { adapter: 'overlap', fields: ['title', 'tags'], window: 40 }
    const expected = await oracleOrder(client, setup.documents, base, 40, 'storm quiet', rerank.fields)

    for (let round = 0; round < 8; round++) {
      expectSameOrder(await walk(client, { ...base, rerank }, 25), expected)
    }
  }, 120_000)
})
