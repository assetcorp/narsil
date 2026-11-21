import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getJson, postJson, postRaw, putJson, startTestServer, type TestServer } from './helpers'

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

  it('answers 400 to an optional body that holds JSON other than an object, and starts no task', async () => {
    const paths = [
      '/indexes/shapes/vectors/_optimize',
      '/indexes/shapes/vectors/_compact',
      '/indexes/shapes/_change-analysis',
      '/indexes/shapes/_rebalance',
      '/indexes/shapes/partition-config',
    ]
    for (const path of paths) {
      for (const body of ['null', 'false', '0', '""', '[]', '7', '"text"']) {
        const res = await postRaw<ErrorBody>(srv.base, path, body, 'application/json')
        expect({
          path,
          body,
          status: res.status,
          code: res.body?.error.code,
          message: res.body?.error.message,
        }).toEqual({
          path,
          body,
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'The request body must be an object',
        })
      }
    }
    const tasks = await getJson<{ total: number }>(srv.base, '/tasks')
    expect(tasks.body.total).toBe(0)
  })

  it('answers 400 to a required body that holds JSON other than an object, and creates nothing', async () => {
    const routes = [
      ['POST', '/indexes'],
      ['POST', '/indexes/shapes/documents'],
      ['POST', '/indexes/shapes/documents/_batch'],
      ['POST', '/indexes/shapes/documents/_list'],
      ['POST', '/indexes/shapes/documents/_multi-get'],
      ['POST', '/indexes/shapes/search'],
      ['POST', '/indexes/shapes/search/preflight'],
      ['POST', '/indexes/shapes/suggest'],
      ['PUT', '/indexes/shapes/documents/one'],
      ['PATCH', '/indexes/shapes/documents/one'],
    ]
    for (const [method, path] of routes) {
      for (const body of ['null', 'false', '0', '""', '[]', '7', '"text"']) {
        const res = await fetch(`${srv.base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body,
        })
        const text = await res.text()
        const answer = text.length === 0 ? null : (JSON.parse(text) as ErrorBody)
        expect({
          method,
          path,
          body,
          status: res.status,
          code: answer?.error.code,
          message: answer?.error.message,
        }).toEqual({
          method,
          path,
          body,
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'The request body must be an object',
        })
      }
    }
    const indexes = await getJson<{ indexes: unknown[] }>(srv.base, '/indexes')
    expect(indexes.body.indexes).toEqual([])
  })

  it('returns 404 for an unknown route', async () => {
    const res = await getJson<ErrorBody>(srv.base, '/does/not/exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

describe('Narsil HTTP server search option types', () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer()
    await postJson(srv.base, '/indexes', { name: 'notes', config: { schema: { title: 'string', year: 'number' } } })
    await putJson(srv.base, '/indexes/notes/documents/a', { document: { title: 'harbor stone', year: 2020 } })
    await putJson(srv.base, '/indexes/notes/documents/b', { document: { title: 'harbor light', year: 2011 } })
  })

  afterAll(async () => {
    await srv.stop()
  })

  it('answers 400 with the field path to a search option of the wrong type, on search and preflight', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ term: 5 }, 'Field "term" must be a string'],
      [{ term: 'harbor', limit: '5' }, 'Field "limit" must be a number'],
      [{ term: 'harbor', fields: 'title' }, 'Field "fields" must be a list of strings'],
      [{ term: 'harbor', termMatch: 'some' }, 'Field "termMatch" must be "all", "any", or a number'],
      [{ term: 'harbor', mode: 'semantic' }, 'Field "mode" must be one of "vector", "hybrid", or "fulltext"'],
      [{ term: 'harbor', highlight: {} }, 'Field "highlight.fields" is required and must be a list of strings'],
      [
        { term: 'harbor', facets: { year: { ranges: [{ from: 0 }] } } },
        'Field "facets.year.ranges.0.to" is required and must be a number',
      ],
      [{ term: 'harbor', sort: 'year' }, 'Field "sort" must be an object keyed by field name, or a list of fields'],
      [{ term: 'harbor', document: 'yes' }, 'Field "document" must be true, false, or an object'],
      [{ term: 'harbor', group: { fields: ['year'], maxPerGroup: '2' } }, 'Field "group.maxPerGroup" must be a number'],
    ]
    for (const [body, message] of cases) {
      for (const path of ['/indexes/notes/search', '/indexes/notes/search/preflight']) {
        const res = await postJson<ErrorBody>(srv.base, path, body)
        expect({ path, body, status: res.status, error: res.body.error }).toEqual({
          path,
          body,
          status: 400,
          error: { code: 'document' in body ? 'SEARCH_INVALID_FIELD' : 'INVALID_REQUEST', message },
        })
      }
    }
  })

  it('reads a search option set to null as absent', async () => {
    const res = await postJson<{ hits: Array<{ id: string }>; count: number }>(srv.base, '/indexes/notes/search', {
      term: 'harbor',
      limit: null,
      highlight: null,
      sort: { year: 'asc' },
    })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.hits.map(hit => hit.id)).toEqual(['b', 'a'])
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
