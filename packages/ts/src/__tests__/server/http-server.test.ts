import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  del,
  getJson,
  patchJson,
  postJson,
  postRaw,
  putJson,
  startTestServer,
  type TestServer,
  toNdjson,
} from './helpers'

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

  it('creates, lists, inspects, and drops an index', async () => {
    await createMovies(srv.base)

    const list = await getJson<{ indexes: Array<{ name: string }> }>(srv.base, '/indexes')
    expect(list.body.indexes.map(i => i.name)).toContain('movies')

    const stats = await getJson<{ documentCount: number }>(srv.base, '/indexes/movies/stats')
    expect(stats.status).toBe(200)
    expect(stats.body.documentCount).toBe(0)

    const dropped = await del(srv.base, '/indexes/movies')
    expect(dropped.status).toBe(200)

    const after = await getJson<{ indexes: unknown[] }>(srv.base, '/indexes')
    expect(after.body.indexes).toHaveLength(0)
  })

  it('runs the single-document lifecycle', async () => {
    await createMovies(srv.base)

    const inserted = await postJson<{ id: string }>(srv.base, '/indexes/movies/documents', {
      document: MOVIES[0],
      id: 'm1',
    })
    expect(inserted.status).toBe(201)
    expect(inserted.body.id).toBe('m1')

    const fetched = await getJson<{ document: { title: string } }>(srv.base, '/indexes/movies/documents/m1')
    expect(fetched.status).toBe(200)
    expect(fetched.body.document.title).toBe('The Matrix')

    const exists = await getJson<{ exists: boolean }>(srv.base, '/indexes/movies/documents/m1/_exists')
    expect(exists.body.exists).toBe(true)

    const patched = await patchJson(srv.base, '/indexes/movies/documents/m1', {
      document: { ...MOVIES[0], title: 'The Matrix Reloaded' },
    })
    expect(patched.status).toBe(200)

    const afterPatch = await getJson<{ document: { title: string } }>(srv.base, '/indexes/movies/documents/m1')
    expect(afterPatch.body.document.title).toBe('The Matrix Reloaded')

    const removed = await del(srv.base, '/indexes/movies/documents/m1')
    expect(removed.status).toBe(200)

    const gone = await getJson(srv.base, '/indexes/movies/documents/m1')
    expect(gone.status).toBe(404)
  })

  it('upserts with PUT', async () => {
    await createMovies(srv.base)

    const first = await putJson<{ created: boolean }>(srv.base, '/indexes/movies/documents/m9', {
      document: { title: 'New', overview: 'x', embedding: [0, 0, 0, 1] },
    })
    expect(first.status).toBe(201)
    expect(first.body.created).toBe(true)

    const second = await putJson<{ created: boolean }>(srv.base, '/indexes/movies/documents/m9', {
      document: { title: 'Replaced', overview: 'y', embedding: [0, 0, 0, 1] },
    })
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)

    const fetched = await getJson<{ document: { title: string } }>(srv.base, '/indexes/movies/documents/m9')
    expect(fetched.body.document.title).toBe('Replaced')
  })

  it('ingests a batch and reads it back', async () => {
    await createMovies(srv.base)

    const batch = await postJson<{ succeeded: string[] }>(srv.base, '/indexes/movies/documents/_batch', {
      action: 'insert',
      documents: MOVIES,
    })
    expect(batch.status).toBe(200)
    expect(batch.body.succeeded.sort()).toEqual(['m1', 'm2', 'm3'])

    const count = await getJson<{ count: number }>(srv.base, '/indexes/movies/count')
    expect(count.body.count).toBe(3)

    const multi = await postJson<{ documents: Record<string, { title: string }> }>(
      srv.base,
      '/indexes/movies/documents/_multi-get',
      { docIds: ['m1', 'm3'] },
    )
    expect(Object.keys(multi.body.documents).sort()).toEqual(['m1', 'm3'])
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

    const result = await postJson<{ hits: Array<{ id: string }> }>(srv.base, '/indexes/movies/search', {
      mode: 'fulltext',
      term: 'matrix',
      fields: ['title'],
    })
    expect(result.status).toBe(200)
    expect(result.body.hits[0]?.id).toBe('m1')
  })

  it('searches by vector', async () => {
    await createMovies(srv.base)
    await postJson(srv.base, '/indexes/movies/documents/_batch', { action: 'insert', documents: MOVIES })

    const result = await postJson<{ hits: Array<{ id: string }> }>(srv.base, '/indexes/movies/search', {
      mode: 'vector',
      vector: { field: 'embedding', value: [0, 1, 0, 0] },
      limit: 1,
    })
    expect(result.status).toBe(200)
    expect(result.body.hits[0]?.id).toBe('m2')
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

  it('suggests terms by prefix', async () => {
    await createMovies(srv.base)
    await postJson(srv.base, '/indexes/movies/documents/_batch', { action: 'insert', documents: MOVIES })

    const result = await postJson<{ terms: Array<{ term: string }> }>(srv.base, '/indexes/movies/suggest', {
      prefix: 'inter',
    })
    expect(result.status).toBe(200)
    expect(result.body.terms.some(t => t.term.startsWith('inter'))).toBe(true)
  })
})
