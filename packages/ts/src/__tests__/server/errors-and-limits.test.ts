import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getJson, postJson, postRaw, startTestServer, type TestServer } from './helpers'

const SCHEMA = { title: 'string', embedding: 'vector[4]' }

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

describe('Narsil HTTP server error mapping and limits', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer()
  })

  afterAll(async () => {
    await srv.stop()
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await postRaw<ErrorBody>(srv.base, '/indexes', '{ not json', 'application/json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_JSON')
  })

  it('rejects a create request missing the name', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes', { config: { schema: SCHEMA } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('maps an invalid schema to 400', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes', {
      name: 'broken',
      config: { schema: { title: 'not-a-real-type' } },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code.startsWith('SCHEMA_')).toBe(true)
  })

  it('returns 404 for an unknown route', async () => {
    const res = await getJson<ErrorBody>(srv.base, '/does/not/exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

describe('Narsil HTTP server body limits', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer({ limits: { maxBodyBytes: 50 } })
  })

  afterAll(async () => {
    await srv.stop()
  })

  it('rejects an oversized body with 413', async () => {
    const big = { name: 'movies', config: { schema: SCHEMA, note: 'x'.repeat(500) } }
    const res = await postJson<ErrorBody>(srv.base, '/indexes', big)
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('Narsil HTTP server result-window and fetch limits', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer({ limits: { maxResultWindow: 5, maxFetchDocuments: 3 } })
    await postJson(srv.base, '/indexes', { name: 'movies', config: { schema: { title: 'string' } } })
  })

  afterAll(async () => {
    await srv.stop()
  })

  it('rejects a search whose limit exceeds the result window', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes/movies/search', { term: 'x', limit: 6 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.details).toMatchObject({ limit: 5 })
  })

  it('rejects a search whose offset exceeds the result window', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes/movies/search', { term: 'x', offset: 6 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('rejects a search whose group.maxPerGroup exceeds the result window', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes/movies/search', {
      term: 'x',
      group: { fields: ['title'], maxPerGroup: 6 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('rejects a search whose facet limit exceeds the result window', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes/movies/search', {
      term: 'x',
      facets: { title: { limit: 6 } },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('accepts a search at the result-window boundary', async () => {
    const res = await postJson(srv.base, '/indexes/movies/search', { term: 'x', limit: 5, offset: 5 })
    expect(res.status).toBe(200)
  })

  it('rejects a multi-get requesting more ids than the fetch limit', async () => {
    const res = await postJson<ErrorBody>(srv.base, '/indexes/movies/documents/_multi-get', {
      docIds: ['a', 'b', 'c', 'd'],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.details).toMatchObject({ count: 4, limit: 3 })
  })

  it('accepts a multi-get at the fetch-limit boundary', async () => {
    const res = await postJson(srv.base, '/indexes/movies/documents/_multi-get', { docIds: ['a', 'b', 'c'] })
    expect(res.status).toBe(200)
  })
})

describe('Narsil HTTP server auth hook', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer({
      onRequest: ctx =>
        ctx.headers['x-api-key'] === 'secret'
          ? undefined
          : { status: 401, code: 'UNAUTHORIZED', message: 'API key required' },
    })
  })

  afterAll(async () => {
    await srv.stop()
  })

  it('allows health probes without auth', async () => {
    const res = await fetch(`${srv.base}/livez`)
    expect(res.status).toBe(200)
  })

  it('denies a gated route without the key', async () => {
    const res = await fetch(`${srv.base}/indexes`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('allows a gated route with the key', async () => {
    const res = await fetch(`${srv.base}/indexes`, { headers: { 'x-api-key': 'secret' } })
    expect(res.status).toBe(200)
  })
})
