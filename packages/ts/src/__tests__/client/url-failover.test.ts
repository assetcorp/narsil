import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { NarsilError } from '../../errors'
import { startTestServer, type TestServer } from '../server/helpers'

const SCHEMA = { title: 'string' }

interface Stub {
  base: string
  requests: string[]
  close(): Promise<void>
}

async function closedPortUrl(): Promise<string> {
  const probe = createNetServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>(resolve => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('the probe never bound a port')
  return `http://127.0.0.1:${address.port}`
}

async function startStub(answer: 'unavailable' | 'not-ready' | 'silent'): Promise<Stub> {
  const requests: string[] = []
  const server: Server = createHttpServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (answer === 'silent') return
    const code = answer === 'not-ready' ? 'NODE_NOT_READY' : 'WORKER_CRASHED'
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code, message: 'the node cannot take this request yet' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub never bound a port')
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function failureOf(work: Promise<unknown>): Promise<NarsilError> {
  const caught = await work.catch((err: unknown) => err)
  expect(caught).toBeInstanceOf(NarsilError)
  return caught as NarsilError
}

describe('a client given a list of server URLs', () => {
  let live: TestServer
  const stubs: Stub[] = []

  beforeEach(async () => {
    live = await startTestServer()
    await createNarsilClient({ url: live.base }).createIndex('charts', { schema: SCHEMA, language: 'english' })
  })

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.close()
    await live.stop()
  })

  async function stub(answer: 'unavailable' | 'not-ready' | 'silent'): Promise<Stub> {
    const started = await startStub(answer)
    stubs.push(started)
    return started
  }

  it('moves reads and writes past a URL that refuses the connection, and stores each write once', async () => {
    const client = createNarsilClient({ url: [await closedPortUrl(), live.base] })
    const titles = Array.from({ length: 8 }, (_, index) => `sounding ${index}`)

    const ids: string[] = []
    for (const title of titles) ids.push(await client.insert('charts', { title }))

    expect(await live.engine.countDocuments('charts')).toBe(titles.length)
    const stored = await client.getMultiple('charts', ids)
    expect(ids.map(id => stored.get(id)?.title)).toEqual(titles)
    const found = await client.query('charts', { term: 'sounding', limit: 20 })
    expect(found.count).toBe(titles.length)
  })

  it('sends a write that a server answers with 503 nowhere else, and moves a read on', async () => {
    const unavailable = await stub('unavailable')
    const client = createNarsilClient({ url: [unavailable.base, live.base] })

    const refused = await failureOf(client.insert('charts', { title: 'reef' }))
    expect(refused.code).toBe('WORKER_CRASHED')
    expect(await live.engine.countDocuments('charts')).toBe(0)
    expect(unavailable.requests).toEqual(['POST /indexes/charts/documents'])

    await live.engine.insert('charts', { title: 'reef' }, 'reef')
    const read = createNarsilClient({ url: [unavailable.base, live.base] })
    expect((await read.get('charts', 'reef'))?.title).toBe('reef')
    expect((await read.query('charts', { term: 'reef' })).hits.map(hit => hit.id)).toEqual(['reef'])
  })

  it('sends a write that timed out nowhere else, and moves a read on after its timeout', async () => {
    const silent = await stub('silent')
    const client = createNarsilClient({ url: [silent.base, live.base], timeoutMs: 300 })

    const timedOut = await failureOf(client.insert('charts', { title: 'shoal' }))
    expect(timedOut.code).toBe('CLIENT_REQUEST_TIMEOUT')
    expect(await live.engine.countDocuments('charts')).toBe(0)

    await live.engine.insert('charts', { title: 'shoal' }, 'shoal')
    const read = createNarsilClient({ url: [silent.base, live.base], timeoutMs: 300 })
    expect(await read.countDocuments('charts')).toBe(1)
  })

  it('moves a write on where a node answers NODE_NOT_READY', async () => {
    const warming = await stub('not-ready')
    const client = createNarsilClient({ url: [warming.base, live.base] })

    await client.insert('charts', { title: 'channel' }, 'channel')

    expect(warming.requests).toHaveLength(1)
    expect((await live.engine.get('charts', 'channel'))?.title).toBe('channel')
    expect(await live.engine.countDocuments('charts')).toBe(1)
  })

  it.each([
    [{ url: [] }],
    [{ url: ['http://127.0.0.1:1', 'not a url'] }],
  ])('refuses the settings %j with CONFIG_INVALID', settings => {
    let caught: unknown
    try {
      createNarsilClient(settings)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NarsilError)
    expect((caught as NarsilError).code).toBe('CONFIG_INVALID')
  })
})
