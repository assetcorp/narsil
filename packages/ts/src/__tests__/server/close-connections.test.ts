import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmbeddingAdapter } from '../../types/adapters'
import { postJson, scaledOut, startTestServer, type TestServer, waitFor } from './helpers'

const DIMENSIONS = 4
const ANSWER_TIMEOUT_MS = 3_000
const DROP_TIMEOUT_MS = 2_000
const LIVENESS_REQUEST = 'GET /livez HTTP/1.1\r\nHost: narsil.test\r\nConnection: keep-alive\r\n\r\n'

interface RawAnswer {
  status: number
  headers: Map<string, string>
  body: string
}

function parseAnswer(raw: string): RawAnswer | null {
  const headerEnd = raw.indexOf('\r\n\r\n')
  if (headerEnd === -1) return null
  const [statusLine = '', ...headerLines] = raw.slice(0, headerEnd).split('\r\n')
  const headers = new Map<string, string>()
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  const length = Number(headers.get('content-length') ?? 0)
  const body = raw.slice(headerEnd + 4)
  if (body.length < length) return null
  return { status: Number(statusLine.split(' ')[1]), headers, body: body.slice(0, length) }
}

function nextAnswer(socket: Socket): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    let received = ''
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      settle()
    }
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1')
      const answer = parseAnswer(received)
      if (answer !== null) finish(() => resolve(answer))
    }
    const onClose = (): void => finish(() => reject(new Error('The server closed the connection before answering')))
    const timer = setTimeout(
      () => finish(() => reject(new Error('The server sent no answer on the open connection'))),
      ANSWER_TIMEOUT_MS,
    )
    socket.on('data', onData)
    socket.on('close', onClose)
  })
}

function dropped(socket: Socket): Promise<'dropped' | 'still open'> {
  if (socket.destroyed) return Promise.resolve('dropped')
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('still open'), DROP_TIMEOUT_MS)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve('dropped')
    })
  })
}

async function openConnection(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  await new Promise(resolve => socket.once('connect', resolve))
  return socket
}

async function idleKeptAliveConnection(port: number): Promise<Socket> {
  const socket = await openConnection(port)
  const answered = nextAnswer(socket)
  socket.write(LIVENESS_REQUEST)
  expect((await answered).status).toBe(200)
  return socket
}

interface HeldAdapter {
  adapter: EmbeddingAdapter
  embedding: Promise<void>
  release(): void
}

function heldAdapter(): HeldAdapter {
  let started: () => void = () => undefined
  let release: () => void = () => undefined
  const embedding = new Promise<void>(resolve => {
    started = resolve
  })
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const adapter: EmbeddingAdapter = {
    dimensions: DIMENSIONS,
    async embed(input: string, purpose: 'document' | 'query'): Promise<Float32Array> {
      if (purpose === 'document') {
        started()
        await released
      }
      const vector = new Float32Array(DIMENSIONS)
      vector[input.length % DIMENSIONS] = 1
      return vector
    },
  }
  return { adapter, embedding, release: () => release() }
}

describe('closing the server while clients hold connections', () => {
  const sockets: Socket[] = []
  let server: TestServer | null = null

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy()
    await server?.stop()
    server = null
  })

  it('drops an idle kept-alive connection and answers nothing more on it', async () => {
    server = await startTestServer({}, { workers: { enabled: false } })
    const socket = await idleKeptAliveConnection(server.server.listeningPort)
    sockets.push(socket)
    let lateAnswer = ''
    socket.on('data', chunk => {
      lateAnswer += chunk.toString('latin1')
    })

    await server.server.close()
    if (!socket.destroyed) socket.write(LIVENESS_REQUEST)

    expect(await dropped(socket)).toBe('dropped')
    expect(lateAnswer).toBe('')
  })

  it.each([false, true])('drains a write and refuses every later request with workers %s', async workers => {
    const held = heldAdapter()
    let lateHooks = 0
    server = await startTestServer(
      {
        embeddingAdapters: { held: held.adapter },
        cors: true,
        onRequest(ctx) {
          if (ctx.headers['x-late-request']) lateHooks++
          return undefined
        },
      },
      { workers: { enabled: workers, count: 2 } },
      async engine => {
        if (!workers) return
        await engine.createIndex('copies', { schema: { title: 'string' } })
        await engine.insertBatch(
          'copies',
          Array.from({ length: 1_000 }, (_, i) => ({ id: `copy-${i}`, title: 'report' })),
        )
        await waitFor(() => scaledOut(engine, 'copies'))
        await engine.waitForWrites('copies')
      },
    )
    if (workers) expect(server.server.requestThreadCount).toBeGreaterThan(0)
    const created = await postJson(server.base, '/indexes', {
      name: 'articles',
      config: {
        schema: { title: 'string', embedding: `vector[${DIMENSIONS}]` },
        embedding: { adapter: 'held', fields: { embedding: ['title'] } },
      },
    })
    expect(created.status).toBe(201)
    const port = server.server.listeningPort

    const writing = await openConnection(port)
    const lateRequests = [
      LIVENESS_REQUEST,
      'GET /missing HTTP/1.1\r\nHost: narsil.test\r\n\r\n',
      'OPTIONS /indexes HTTP/1.1\r\nHost: narsil.test\r\nOrigin: https://narsil.test\r\n\r\n',
      'GET /indexes/%zz/stats HTTP/1.1\r\nHost: narsil.test\r\n\r\n',
      'POST /indexes HTTP/1.1\r\nHost: narsil.test\r\nContent-Type: application/json\r\nContent-Length: 100\r\nX-Late-Request: yes\r\n\r\n{',
    ]
    const idle = await Promise.all(lateRequests.map(() => idleKeptAliveConnection(port)))
    sockets.push(writing, ...idle)
    const body = JSON.stringify({ documents: [{ id: 'held-write', title: 'tidal power along the coast' }] })
    const written = nextAnswer(writing)
    writing.write(
      `POST /indexes/articles/documents/_batch HTTP/1.1\r\nHost: narsil.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    await held.embedding

    let closed = false
    const closing = server.server.close().then(() => {
      closed = true
    })
    try {
      for (const [i, socket] of idle.entries()) {
        const refused = nextAnswer(socket)
        socket.write(lateRequests[i])
        const refusal = await refused
        expect(refusal.status).toBe(503)
        expect(refusal.headers.get('connection')?.toLowerCase()).toBe('close')
        expect(await dropped(socket)).toBe('dropped')
      }
      expect(closed).toBe(false)
      expect(lateHooks).toBe(0)
    } finally {
      held.release()
    }
    const answer = await written
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ succeeded: ['held-write'], failed: [] })
    await closing
    expect(await dropped(writing)).toBe('dropped')
    expect(await server.engine.get('articles', 'held-write')).toMatchObject({ title: 'tidal power along the coast' })
  })
})
