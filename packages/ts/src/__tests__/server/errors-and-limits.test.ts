import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJson, postJson, postRaw, startTestServer, type TestServer } from './helpers'

const SCHEMA = { title: 'string', embedding: 'vector[4]' }

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

describe('Narsil HTTP server error mapping and limits', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer()
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('maps a missing index to 404 with a stable code', async () => {
    const res = await getJson<ErrorBody>(srv.base, '/indexes/missing/stats')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('INDEX_NOT_FOUND')
  })

  it('maps a duplicate index to 409', async () => {
    await postJson(srv.base, '/indexes', { name: 'movies', config: { schema: SCHEMA } })
    const dup = await postJson<ErrorBody>(srv.base, '/indexes', { name: 'movies', config: { schema: SCHEMA } })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('INDEX_ALREADY_EXISTS')
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

  it('preserves per-document failures in a batch', async () => {
    await postJson(srv.base, '/indexes', {
      name: 'strict',
      config: { schema: { title: 'string' }, required: ['title'] },
    })
    const res = await postJson<{ succeeded: string[]; failed: Array<{ error: { code: string } }> }>(
      srv.base,
      '/indexes/strict/documents/_batch',
      { action: 'insert', documents: [{ title: 'has title' }, { note: 'no title' }] },
    )
    expect(res.status).toBe(200)
    expect(res.body.succeeded).toHaveLength(1)
    expect(res.body.failed).toHaveLength(1)
    expect(res.body.failed[0].error.code).toBe('DOC_MISSING_REQUIRED_FIELD')
  })
})

describe('Narsil HTTP server body limits', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer({ limits: { maxBodyBytes: 50 } })
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('rejects an oversized body with 413', async () => {
    const big = { name: 'movies', config: { schema: SCHEMA, note: 'x'.repeat(500) } }
    const res = await postJson<ErrorBody>(srv.base, '/indexes', big)
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('Narsil HTTP server auth hook', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer({
      onRequest: ctx =>
        ctx.headers['x-api-key'] === 'secret'
          ? undefined
          : { status: 401, code: 'UNAUTHORIZED', message: 'API key required' },
    })
  })

  afterEach(async () => {
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

describe('Narsil HTTP server async tasks', () => {
  let srv: TestServer

  beforeEach(async () => {
    srv = await startTestServer()
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('acknowledges optimizeVectors with a task id and completes it', async () => {
    await postJson(srv.base, '/indexes', { name: 'movies', config: { schema: SCHEMA } })
    await postJson(srv.base, '/indexes/movies/documents/_batch', {
      action: 'insert',
      documents: [
        { id: 'a', title: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', title: 'b', embedding: [0, 1, 0, 0] },
        { id: 'c', title: 'c', embedding: [0, 0, 1, 0] },
      ],
    })

    const accepted = await postJson<{ taskId: string; status: string }>(srv.base, '/indexes/movies/vectors/_optimize', {
      field: 'embedding',
    })
    expect(accepted.status).toBe(202)
    expect(accepted.body.taskId).toBeTruthy()

    const final = await pollTask(srv.base, accepted.body.taskId)
    expect(final.status).toBe('succeeded')
  })

  it('returns 404 for an unknown task id', async () => {
    const res = await getJson<ErrorBody>(srv.base, '/tasks/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('TASK_NOT_FOUND')
  })
})

async function pollTask(base: string, id: string, timeoutMs = 4000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await getJson<{ status: string }>(base, `/tasks/${id}`)
    if (res.body.status !== 'running' && res.body.status !== 'queued') return res.body
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('task did not reach a terminal state in time')
}
