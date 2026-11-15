import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueryCoverage } from '../../types/results'
import { vectorSearchPath } from '../../vector/native/search-path'
import { getJson, postJson, postRaw, scaledOut, startTestServer, type TestServer, toNdjson, waitFor } from './helpers'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const INSTALLED_VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string })
  .version

const SCHEMA = { title: 'string', overview: 'string', embedding: 'vector[4]' }

const MOVIES = [
  { id: 'm1', title: 'The Matrix', overview: 'A hacker discovers reality', embedding: [1, 0, 0, 0] },
  { id: 'm2', title: 'Inception', overview: 'A thief enters shared dreams', embedding: [0, 1, 0, 0] },
  { id: 'm3', title: 'Interstellar', overview: 'Space travel and relativity', embedding: [0, 0, 1, 0] },
]

async function createMovies(base: string): Promise<void> {
  const created = await postJson(base, '/indexes', { name: 'movies', config: { schema: SCHEMA } })
  expect(created.status).toBe(201)
}

describe('Narsil HTTP server', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer()
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('reports liveness and readiness', async () => {
    const live = await getJson<{ status: string }>(srv.base, '/livez')
    expect(live.status).toBe(200)
    expect(live.body.status).toBe('ok')

    const ready = await getJson<{ status: string }>(srv.base, '/readyz')
    expect(ready.status).toBe(200)
    expect(ready.body.status).toBe('ready')
  })

  it('reports the installed package version at /version when the caller passes no build', async () => {
    const res = await getJson<{ name: string; version: string | null; gitSha: string | null; dirty: boolean }>(
      srv.base,
      '/version',
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'narsil', version: INSTALLED_VERSION, gitSha: null, dirty: false })
  })

  it('reports at /version the path through which this process searches vector graphs', async () => {
    const res = await getJson<{ vectorSearch: string }>(srv.base, '/version')
    expect(res.status).toBe(200)
    expect(['native', 'wasm']).toContain(res.body.vectorSearch)
    expect(res.body.vectorSearch).toBe(vectorSearchPath())
  })

  it('reports the stamped build identity at /version', async () => {
    const stamped = await startTestServer({ build: { version: '1.2.3', gitSha: 'abc123def456', dirty: true } })
    try {
      const res = await getJson<{ version: string; gitSha: string; dirty: boolean }>(stamped.base, '/version')
      expect(res.status).toBe(200)
      expect(res.body.version).toBe('1.2.3')
      expect(res.body.gitSha).toBe('abc123def456')
      expect(res.body.dirty).toBe(true)
    } finally {
      await stamped.stop()
    }
  })

  it('pages every document through the listing endpoint', async () => {
    await createMovies(srv.base)
    await postJson(srv.base, '/indexes/movies/documents/_batch', { action: 'insert', documents: MOVIES })

    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await postJson<{ documents: Array<{ id: string }>; cursor: string | null; total: number }>(
        srv.base,
        '/indexes/movies/documents/_list',
        { limit: 2, cursor },
      )
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(3)
      for (const entry of page.body.documents) seen.push(entry.id)
      if (page.body.cursor === null) break
      cursor = page.body.cursor
    }

    expect(seen).toEqual(['m1', 'm2', 'm3'])
  })

  it('rejects a listing cursor the server did not issue', async () => {
    await createMovies(srv.base)

    const result = await postJson<{ error: { code: string } }>(srv.base, '/indexes/movies/documents/_list', {
      cursor: 'not-a-cursor',
    })

    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('imports an NDJSON stream and honors each document id', async () => {
    await createMovies(srv.base)

    const ndjson = toNdjson(MOVIES)
    const result = await postRaw<{ indexed: number; failed: number }>(
      srv.base,
      '/indexes/movies/documents/_import',
      ndjson,
      'application/x-ndjson',
    )
    expect(result.status).toBe(200)
    expect(result.body.indexed).toBe(3)
    expect(result.body.failed).toBe(0)

    const count = await getJson<{ count: number }>(srv.base, '/indexes/movies/count')
    expect(count.body.count).toBe(3)

    const fetched = await getJson<{ document: { title: string } }>(srv.base, '/indexes/movies/documents/m1')
    expect(fetched.status).toBe(200)
    expect(fetched.body.document.title).toBe('The Matrix')
  })

  it('searches full text', async () => {
    await createMovies(srv.base)
    await postJson(srv.base, '/indexes/movies/documents/_batch', { action: 'insert', documents: MOVIES })

    const result = await postJson<{ hits: Array<{ id: string }>; coverage: QueryCoverage }>(
      srv.base,
      '/indexes/movies/search',
      {
        mode: 'fulltext',
        term: 'matrix',
        fields: ['title'],
      },
    )
    expect(result.status).toBe(200)
    expect(result.body.hits[0]?.id).toBe('m1')
    expect(result.body.coverage).toEqual({
      totalPartitions: 1,
      queriedPartitions: 1,
      timedOutPartitions: 0,
      failedPartitions: 0,
    })
  })

  it('searches hybrid', async () => {
    await createMovies(srv.base)
    await postJson(srv.base, '/indexes/movies/documents/_batch', { action: 'insert', documents: MOVIES })

    const result = await postJson<{ hits: Array<{ id: string }> }>(srv.base, '/indexes/movies/search', {
      mode: 'hybrid',
      term: 'dreams',
      fields: ['overview'],
      vector: { field: 'embedding', value: [0, 1, 0, 0] },
      hybrid: { strategy: 'rrf' },
    })
    expect(result.status).toBe(200)
    expect(result.body.hits.map(h => h.id)).toContain('m2')
  })
})

const COPY_THRESHOLD = 100
const DOCUMENTS_PAST_THE_COPY_THRESHOLD = 200
const VECTOR_DIMENSION = 8

function catalogue(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `d${i}`,
    title: `${i % 7 === 0 ? 'alpha' : 'beta'} item ${i}`,
    overview: `overview ${i}`,
    embedding: Array.from({ length: VECTOR_DIMENSION }, (_, k) => Math.sin(i * (k + 1))),
  }))
}

const CATALOGUE_CONFIG = {
  schema: { title: 'string' as const, overview: 'string' as const, embedding: `vector[${VECTOR_DIMENSION}]` as const },
  vectorPromotion: { threshold: 64, quantization: 'none' as const },
}

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

describe.skipIf(!built)('request threads answer from the copies they hold', () => {
  let srv: TestServer
  let documents: Array<Record<string, unknown>>

  beforeEach(async () => {
    documents = catalogue(COPY_THRESHOLD + DOCUMENTS_PAST_THE_COPY_THRESHOLD)
    srv = await startTestServer(
      undefined,
      { workers: { count: 2, promotionThreshold: COPY_THRESHOLD } },
      async engine => {
        await engine.createIndex('catalogue', CATALOGUE_CONFIG)
        await engine.createIndex('small', CATALOGUE_CONFIG)
        await engine.insertBatch('catalogue', documents)
        await engine.insertBatch('small', documents.slice(0, 5))
      },
    )
    await waitFor(() => scaledOut(srv.engine, 'catalogue'))
    await srv.engine.waitForWrites('catalogue')
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('answers a text search on a scaled-out index and on a small index', async () => {
    const onCopy = await postJson<{ hits: Array<{ id: string }>; count: number }>(
      srv.base,
      '/indexes/catalogue/search',
      { term: 'alpha', limit: 5 },
    )
    expect(onCopy.status).toBe(200)
    expect(onCopy.body.hits.length).toBe(5)
    expect(onCopy.body.count).toBe(documents.filter(doc => String(doc.title).startsWith('alpha')).length)

    const onMain = await postJson<{ hits: Array<{ id: string }> }>(srv.base, '/indexes/small/search', {
      term: 'alpha',
      limit: 5,
    })
    expect(onMain.status).toBe(200)
    expect(onMain.body.hits.map(hit => hit.id)).toEqual(['d0'])
  })

  it('answers hybrid and vector searches from the shared vector copy with the hits the main copy gives', async () => {
    const vector = documents[7].embedding as number[]
    const expected = await srv.engine.query('catalogue', {
      mode: 'hybrid',
      term: 'alpha',
      vector: { field: 'embedding', value: vector },
      limit: 5,
    })
    const hybrid = await postJson<{ hits: Array<{ id: string; score: number }> }>(
      srv.base,
      '/indexes/catalogue/search',
      { mode: 'hybrid', term: 'alpha', vector: { field: 'embedding', value: vector }, limit: 5 },
    )
    expect(hybrid.status).toBe(200)
    expect(hybrid.body.hits.map(hit => hit.id)).toEqual(expected.hits.map(hit => hit.id))
  })

  it('answers 400 VECTOR_DIMENSION_MISMATCH from a copy when the query vector has the wrong length', async () => {
    const response = await postJson<{ error: { code: string; details?: { expected: number; received: number } } }>(
      srv.base,
      '/indexes/catalogue/search',
      { mode: 'vector', vector: { field: 'embedding', value: [0.1, 0.2, 0.3] }, limit: 5 },
    )
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VECTOR_DIMENSION_MISMATCH')
    expect(response.body.error.details).toEqual({ expected: VECTOR_DIMENSION, received: 3 })
  })

  it('makes a write visible on every copy before it returns when the write carries wait', async () => {
    const inserted = await postJson<{ id: string }>(srv.base, '/indexes/catalogue/documents', {
      document: { id: 'late', title: 'omega late arrival', overview: 'late', embedding: documents[1].embedding },
      options: { wait: true },
    })
    expect(inserted.status).toBe(201)
    const found = await postJson<{ hits: Array<{ id: string }> }>(srv.base, '/indexes/catalogue/search', {
      term: 'omega',
      limit: 5,
    })
    expect(found.body.hits.map(hit => hit.id)).toEqual(['late'])
  })

  it('applies every earlier write to the copies before waitForWrites answers', async () => {
    for (let i = 0; i < 20; i++) {
      await postJson(srv.base, '/indexes/catalogue/documents', {
        document: { id: `gamma-${i}`, title: `gamma ${i}`, overview: 'x', embedding: documents[2].embedding },
      })
    }
    const waited = await postJson<{ ok: boolean }>(srv.base, '/indexes/catalogue/_wait-for-writes', {})
    expect(waited.status).toBe(200)
    const found = await postJson<{ count: number }>(srv.base, '/indexes/catalogue/search', { term: 'gamma', limit: 1 })
    expect(found.body.count).toBe(20)
  })

  it('reads, counts, lists, and checks documents on the copy', async () => {
    const fetched = await getJson<{ document: { title: string } }>(srv.base, '/indexes/catalogue/documents/d7')
    expect(fetched.body.document.title).toBe('alpha item 7')
    const exists = await getJson<{ exists: boolean }>(srv.base, '/indexes/catalogue/documents/d7/_exists')
    expect(exists.body.exists).toBe(true)
    const count = await getJson<{ count: number }>(srv.base, '/indexes/catalogue/count')
    expect(count.body.count).toBe(documents.length)
    const page = await postJson<{ documents: Array<{ id: string }>; total: number }>(
      srv.base,
      '/indexes/catalogue/documents/_list',
      { limit: 3 },
    )
    expect(page.body.total).toBe(documents.length)
    expect(page.body.documents).toHaveLength(3)
    const multi = await postJson<{ documents: Record<string, unknown> }>(
      srv.base,
      '/indexes/catalogue/documents/_multi-get',
      { docIds: ['d1', 'd2', 'missing'] },
    )
    expect(Object.keys(multi.body.documents).sort()).toEqual(['d1', 'd2'])
  })
})
