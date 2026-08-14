import { describe, expect, it } from 'vitest'
import { createNarsilClient, type FetchFunction } from '../../client'
import { NarsilError } from '../../errors'

interface Capture {
  url: string
  init: RequestInit
}

function record(): { calls: Capture[]; fetch: FetchFunction } {
  const calls: Capture[] = []
  const fetch: FetchFunction = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify({ indexes: [] }), { status: 200 }))
  }
  return { calls, fetch }
}

function answering(status: number, body: string, contentType = 'application/json'): FetchFunction {
  return () => Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } }))
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined
  return headers?.[name]
}

async function failureOf(work: Promise<unknown>): Promise<NarsilError> {
  const caught = await work.catch((err: unknown) => err)
  expect(caught).toBeInstanceOf(NarsilError)
  return caught as NarsilError
}

describe('client transport', () => {
  it('refuses an address it cannot read as a URL', () => {
    expect(() => createNarsilClient({ url: '' })).toThrow(NarsilError)
    expect(() => createNarsilClient({ url: 'not a url' })).toThrow(NarsilError)
  })

  it('accepts an origin-relative address, for a server behind the same origin', async () => {
    const { calls, fetch } = record()
    await createNarsilClient({ url: '/search-api/', fetch }).listIndexes()
    expect(calls[0].url).toBe('/search-api/indexes')
  })

  it('sends the api key as a bearer token, and lets a per-call header replace one', async () => {
    const { calls, fetch } = record()
    const client = createNarsilClient({
      url: 'http://server',
      apiKey: 'secret',
      headers: { 'x-tenant': 'acme' },
      fetch,
    })

    await client.listIndexes()
    expect(headerOf(calls[0].init, 'authorization')).toBe('Bearer secret')
    expect(headerOf(calls[0].init, 'x-tenant')).toBe('acme')

    await client.listIndexes({ headers: { 'x-tenant': 'other' } })
    expect(headerOf(calls[1].init, 'x-tenant')).toBe('other')
  })

  it('encodes the filters and the page window into the task query string', async () => {
    const calls: Capture[] = []
    const fetch: FetchFunction = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(JSON.stringify({ tasks: [], total: 0, from: 0, limit: 20, next: null })))
    }
    await createNarsilClient({ url: 'http://server', fetch }).listTasks({
      indexName: 'movies',
      type: ['import', 'restore'],
      status: ['running'],
      from: 40,
      limit: 10,
    })
    expect(calls[0].url).toBe(
      'http://server/tasks?indexName=movies&type=import%2Crestore&status=running&from=40&limit=10',
    )
  })

  it('carries the code and the status of the failure the server described', async () => {
    const body = JSON.stringify({
      error: { code: 'SEARCH_INVALID_FILTER', message: 'bad filter', details: { field: 'year' } },
    })
    const client = createNarsilClient({ url: 'http://server', fetch: answering(400, body) })

    const failure = await failureOf(client.query('movies', { term: 'x' }))
    expect(failure.code).toBe('SEARCH_INVALID_FILTER')
    expect(failure.message).toBe('bad filter')
    expect(failure.details).toEqual({ field: 'year', status: 400 })
  })

  it('passes through a code an authentication hook invented', async () => {
    const body = JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'API key required' } })
    const client = createNarsilClient({ url: 'http://server', fetch: answering(401, body) })

    const failure = await failureOf(client.listIndexes())
    expect(failure.code).toBe('UNAUTHORIZED')
    expect(failure.details.status).toBe(401)
  })

  it('reports an answer that is not a Narsil error envelope as an unreadable response', async () => {
    const client = createNarsilClient({
      url: 'http://server',
      fetch: answering(502, '<html>bad gateway</html>', 'text/html'),
    })
    expect((await failureOf(client.listIndexes())).code).toBe('CLIENT_INVALID_RESPONSE')
  })

  it('reports a successful answer missing the field it promised', async () => {
    const client = createNarsilClient({ url: 'http://server', fetch: answering(200, '{"wrong":true}') })
    expect((await failureOf(client.listIndexes())).code).toBe('CLIENT_INVALID_RESPONSE')
  })

  it('reports a server it cannot reach', async () => {
    const client = createNarsilClient({
      url: 'http://server',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    })
    const failure = await failureOf(client.listIndexes())
    expect(failure.code).toBe('CLIENT_CONNECTION_FAILED')
    expect(failure.message).toContain('http://server/indexes')
  })

  it('gives up on a server that never answers', async () => {
    const client = createNarsilClient({
      url: 'http://server',
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const failure = await failureOf(client.listIndexes())
    expect(failure.code).toBe('CLIENT_REQUEST_TIMEOUT')
    expect(failure.details.timeoutMs).toBe(10)
  })

  it('stops a request the caller cancels', async () => {
    const controller = new AbortController()
    const client = createNarsilClient({
      url: 'http://server',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const pending = client.listIndexes({ signal: controller.signal })
    controller.abort()
    expect((await failureOf(pending)).code).toBe('CLIENT_REQUEST_ABORTED')
  })

  it('sends documents as one NDJSON line each', async () => {
    const calls: Capture[] = []
    const fetch: FetchFunction = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(
        new Response(JSON.stringify({ indexed: 2, failed: 0, errors: [], errorsTruncated: false })),
      )
    }
    await createNarsilClient({ url: 'http://server', fetch }).importDocuments('movies', [{ id: 'a' }, { id: 'b' }])
    expect(calls[0].url).toBe('http://server/indexes/movies/documents/_import')
    expect(calls[0].init.body).toBe('{"id":"a"}\n{"id":"b"}')
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/x-ndjson')
  })

  it('asks for an asynchronous import with a query parameter', async () => {
    const calls: Capture[] = []
    const fetch: FetchFunction = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(JSON.stringify({ id: 't1', status: 'running' }), { status: 202 }))
    }
    await createNarsilClient({ url: 'http://server', fetch }).startImport('movies', [{ id: 'a' }])
    expect(calls[0].url).toBe('http://server/indexes/movies/documents/_import?async=true')
  })

  it('treats a server without the capabilities route as one that announces nothing', async () => {
    const body = JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
    const client = createNarsilClient({ url: 'http://server', fetch: answering(404, body) })
    expect(await client.capabilities()).toEqual([])
    expect(await client.supports('tasks.cancel')).toBe(false)
  })

  it('gives up waiting once the wait deadline passes, and leaves the task running', async () => {
    const running = JSON.stringify({ id: 't1', type: 'import', indexName: 'movies', status: 'running' })
    const client = createNarsilClient({ url: 'http://server', fetch: answering(200, running) })

    const failure = await failureOf(client.waitForTask('t1', { pollIntervalMs: 1, waitTimeoutMs: 20 }))
    expect(failure.code).toBe('CLIENT_TASK_TIMEOUT')
    expect(failure.details.status).toBe('running')
  })

  it('reports a record that expired before the task finished', async () => {
    const body = JSON.stringify({ error: { code: 'TASK_NOT_FOUND', message: 'Task "t1" not found' } })
    const client = createNarsilClient({ url: 'http://server', fetch: answering(404, body) })
    expect((await failureOf(client.waitForTask('t1', { pollIntervalMs: 1 }))).code).toBe('TASK_NOT_FOUND')
  })

  it('reports progress only when the figures move', async () => {
    const answers = [
      { id: 't1', status: 'running', progress: { indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: 100 } },
      { id: 't1', status: 'running', progress: { indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: 100 } },
      { id: 't1', status: 'running', progress: { indexed: 5, failed: 0, bytesProcessed: 50, bytesTotal: 100 } },
      { id: 't1', status: 'succeeded', progress: { indexed: 10, failed: 0, bytesProcessed: 100, bytesTotal: 100 } },
    ]
    let call = 0
    const fetch: FetchFunction = () => {
      const answer = answers[Math.min(call, answers.length - 1)]
      call += 1
      return Promise.resolve(new Response(JSON.stringify(answer)))
    }
    const seen: string[] = []
    const client = createNarsilClient({ url: 'http://server', fetch })

    const record = await client.waitForTask('t1', {
      pollIntervalMs: 1,
      onProgress: task => seen.push(`${task.status}:${task.progress?.indexed ?? 0}`),
    })
    expect(record.status).toBe('succeeded')
    expect(seen).toEqual(['running:0', 'running:5', 'succeeded:10'])
  })

  it('reads the capabilities once and keeps the answer', async () => {
    let calls = 0
    const fetch: FetchFunction = () => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify({ capabilities: ['tasks.cancel'] })))
    }
    const client = createNarsilClient({ url: 'http://server', fetch })
    expect(await client.supports('tasks.cancel')).toBe(true)
    expect(await client.supports('tasks.filter')).toBe(false)
    expect(calls).toBe(1)
  })
})
