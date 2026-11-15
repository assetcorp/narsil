import { createServer as createHttpServer, type IncomingMessage, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createServer, type TaskRecord } from '../../server'
import { scaledOut, startTestServer, type TestServer, waitFor } from './helpers'

function signal() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function readResponse(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
    response.on('end', () => resolve(Buffer.concat(chunks).toString()))
    response.on('error', reject)
    response.resume()
  })
}

describe.each([false, true])('server close with request workers %s', workers => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  async function prepare(engine: TestServer['engine']): Promise<void> {
    await engine.createIndex('articles', { schema: { title: 'string', text: 'enum' } })
    if (!workers) return
    await engine.insertBatch(
      'articles',
      Array.from({ length: 1_000 }, (_, i) => ({ id: `article-${i}`, title: 'coastal report', text: '' })),
    )
    await waitFor(() => scaledOut(engine, 'articles'))
    await engine.waitForWrites('articles')
  }

  it('finishes an admitted upload whose authentication calls the engine during close', async () => {
    const admitted = signal()
    const release = signal()
    let countDuringClose = -1
    server = await startTestServer(
      {
        async onRequest(ctx) {
          if (ctx.method !== 'POST') return
          admitted.resolve()
          await release.promise
          countDuringClose = (await server?.engine.countDocuments('articles')) ?? -1
          return undefined
        },
      },
      { workers: { enabled: workers, count: 2 } },
      prepare,
    )
    if (workers) expect(server.server.requestThreadCount).toBeGreaterThan(0)
    const body = JSON.stringify({ id: 'upload', document: { title: 'tidal report', text: 'complete' } })
    const uploading = request(`${server.base}/indexes/articles/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    })
    const answer = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      uploading.on('error', reject)
      uploading.on('response', response => {
        void readResponse(response).then(body => resolve({ status: response.statusCode, body }), reject)
      })
    })
    uploading.write(body.slice(0, 1))
    await admitted.promise
    const closing = server.server.close()
    release.resolve()
    uploading.end(body.slice(1))
    const response = await answer.catch(error => ({ status: 0, body: String(error) }))
    await closing
    expect({ response, stored: await server.engine.get('articles', 'upload'), countDuringClose }).toEqual({
      response: { status: 201, body: JSON.stringify({ id: 'upload' }) },
      stored: { title: 'tidal report', text: 'complete' },
      countDuringClose: workers ? 1_000 : 0,
    })
  }, 30_000)

  it('makes concurrent close and shutdown wait for the admitted request', async () => {
    const admitted = signal()
    const release = signal()
    server = await startTestServer(
      {
        async onRequest() {
          admitted.resolve()
          await release.promise
          return undefined
        },
      },
      { workers: { enabled: workers, count: 2 } },
      prepare,
    )
    const answering = fetch(`${server.base}/indexes/articles/count`).then(async response => ({
      status: response.status,
      body: await response.json(),
    }))
    await admitted.promise
    let secondClosed = false
    let shutDown = false
    const first = server.server.close()
    const second = server.server.close().then(() => {
      secondClosed = true
    })
    const shutdown = server.server.shutdown().then(() => {
      shutDown = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const returnedBeforeRequest = { secondClosed, shutDown }
    release.resolve()
    const answer = await answering
    await Promise.all([first, second, shutdown])
    expect(returnedBeforeRequest).toEqual({ secondClosed: false, shutDown: false })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toEqual({ count: workers ? 1_000 : 0 })
  }, 30_000)

  it('sends the complete JSON document to a paused reader during close', async () => {
    server = await startTestServer({}, { workers: { enabled: workers, count: 2 } }, prepare)
    const text = 'coast'.repeat(2_000_000)
    await server.engine.insert('articles', { title: 'large report', text }, 'large')
    await server.engine.waitForWrites('articles')
    const fetching = request(`${server.base}/indexes/articles/documents/large`)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      fetching.on('error', reject)
      fetching.on('response', resolve)
      fetching.end()
    })
    response.pause()
    let closed = false
    const closing = server.server.close().then(() => {
      closed = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const returnedBeforeRead = closed
    const body = await readResponse(response)
    await closing
    expect(returnedBeforeRead).toBe(false)
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({ document: { title: 'large report', text } })
  }, 30_000)
})

it('can listen after closing before listen and after closing an active listener', async () => {
  const engine = await createNarsil({ workers: { enabled: false } })
  const server = createServer(engine, { port: 0 })
  try {
    await server.close()
    const listening = server.listen()
    const closing = server.close()
    await Promise.all([listening, closing])
    expect(server.listeningPort).toBe(-1)
    await server.listen()
    expect((await fetch(`http://127.0.0.1:${server.listeningPort}/livez`)).status).toBe(200)
    await server.close()
    await server.listen()
    expect((await fetch(`http://127.0.0.1:${server.listeningPort}/livez`)).status).toBe(200)
  } finally {
    await server.shutdown()
  }
})

it('closes while the task store is unavailable during listen', async () => {
  const reachedStore = signal()
  const releaseStore = signal()
  const records = new Map<string, TaskRecord>()
  const store = createHttpServer(async (_request, response) => {
    reachedStore.resolve()
    await releaseStore.promise
    response.end(JSON.stringify([...records.values()]))
  })
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', resolve))
  const address = store.address()
  if (address === null || typeof address === 'string') throw new Error('The task store has no TCP port')
  const engine = await createNarsil({ workers: { enabled: false } })
  const server = createServer(engine, {
    port: 0,
    taskStore: {
      async get(id) {
        return records.get(id) ?? null
      },
      async set(record) {
        records.set(record.id, record)
      },
      async delete(id) {
        records.delete(id)
      },
      async list() {
        const response = await fetch(`http://127.0.0.1:${address.port}`)
        return response.json()
      },
    },
  })
  const listening = server.listen()
  try {
    await reachedStore.promise
    expect((await fetch(`http://127.0.0.1:${server.listeningPort}/livez`)).status).toBe(200)
    const closed = await Promise.race([
      server.close().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ])
    expect(closed).toBe(true)
    expect(server.listeningPort).toBe(-1)
  } finally {
    releaseStore.resolve()
    await listening
    await server.shutdown()
    await new Promise<void>((resolve, reject) => store.close(error => (error ? reject(error) : resolve())))
  }
})
