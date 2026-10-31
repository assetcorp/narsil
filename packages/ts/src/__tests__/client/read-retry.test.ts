import { createServer, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { NarsilError } from '../../errors'

type Reply = 'close' | 'silent' | 'found' | 500 | 502 | 503 | 504

interface Stub {
  base: string
  requests: () => number
}

const HIT = { id: 'reef', score: 1, document: { title: 'reef' } }
const closers: Array<() => Promise<void>> = []

function answer(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

async function startStub(replies: Reply[], onRequest?: () => void): Promise<Stub> {
  let requests = 0
  const server = createServer((request, response) => {
    const reply = replies[Math.min(requests, replies.length - 1)]
    requests += 1
    onRequest?.()
    if (reply === 'close') request.socket.destroy()
    else if (reply === 'found') answer(response, 200, { hits: [HIT], count: 1, elapsed: 0 })
    else if (reply !== 'silent') {
      answer(response, reply, { error: { code: `STUB_${reply}`, message: 'the stub refused this request' } })
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub never bound a port')
  return { base: `http://127.0.0.1:${address.port}`, requests: () => requests }
}

async function failureOf(work: Promise<unknown>): Promise<NarsilError> {
  const caught = await work.catch((err: unknown) => err)
  expect(caught).toBeInstanceOf(NarsilError)
  return caught as NarsilError
}

describe('the one extra try that a client gives a read', () => {
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  it.each<Reply>(['close', 502, 503, 504])('finds the hit on the second try after a first reply of %s', async first => {
    const stub = await startStub([first, 'found'])
    const found = await createNarsilClient({ url: stub.base }).query('charts', { term: 'reef' })
    expect(found.hits.map(hit => hit.id)).toEqual(['reef'])
    expect(stub.requests()).toBe(2)
  })

  it.each<[Reply, string]>([
    ['close', 'CLIENT_CONNECTION_FAILED'],
    [502, 'STUB_502'],
  ])('sends an insert once when the server replies %s', async (reply, code) => {
    const stub = await startStub([reply, 'found'])
    const failure = await failureOf(createNarsilClient({ url: stub.base }).insert('charts', { title: 'reef' }))
    expect(failure.code).toBe(code)
    expect(stub.requests()).toBe(1)
  })

  it.each<[Reply, string]>([
    ['close', 'CLIENT_CONNECTION_FAILED'],
    [503, 'STUB_503'],
  ])('sends a search twice to a server that always replies %s', async (reply, code) => {
    const stub = await startStub([reply])
    const failure = await failureOf(createNarsilClient({ url: stub.base }).query('charts', { term: 'reef' }))
    expect(failure.code).toBe(code)
    expect(stub.requests()).toBe(2)
  })

  it('sends one more request in all when every address in a list fails', async () => {
    const closing = await startStub(['close'])
    const unavailable = await startStub([503])
    const client = createNarsilClient({ url: [closing.base, unavailable.base] })
    await failureOf(client.query('charts', { term: 'reef' }))
    expect(closing.requests() + unavailable.requests()).toBe(3)
  })

  it('stops at the abort of a call that the server is holding', async () => {
    const controller = new AbortController()
    const stub = await startStub(['silent'], () => controller.abort())
    const client = createNarsilClient({ url: stub.base })
    const failure = await failureOf(client.query('charts', { term: 'reef' }, { signal: controller.signal }))
    expect(failure.code).toBe('CLIENT_REQUEST_ABORTED')
    expect(stub.requests()).toBe(1)
  })

  it('takes no extra try after a timeout on the only address', async () => {
    const silent = await startStub(['silent'])
    const client = createNarsilClient({ url: silent.base, timeoutMs: 100 })
    expect((await failureOf(client.query('charts', { term: 'reef' }))).code).toBe('CLIENT_REQUEST_TIMEOUT')
    expect(silent.requests()).toBe(1)
  })

  it('takes no extra try where one address in a list timed out and the other answered 503', async () => {
    const silent = await startStub(['silent'])
    const unavailable = await startStub([503])
    const client = createNarsilClient({ url: [silent.base, unavailable.base], timeoutMs: 100 })
    await failureOf(client.query('charts', { term: 'reef' }))
    expect(silent.requests()).toBe(1)
    expect(unavailable.requests()).toBe(1)
  })

  it('returns a 500 after one request', async () => {
    const stub = await startStub([500, 'found'])
    const failure = await failureOf(createNarsilClient({ url: stub.base }).query('charts', { term: 'reef' }))
    expect(failure.code).toBe('STUB_500')
    expect(stub.requests()).toBe(1)
  })
})
