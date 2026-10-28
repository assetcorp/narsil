import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createHttpReranker } from '../../rerankers/http'

interface Received {
  url: string
  authorization: string | undefined
  body: { model: string; query: string; documents: string[]; top_n: number }
}

type Responder = (received: Received, res: ServerResponse) => void

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function scoreByLength(received: Received): Array<{ index: number; relevance_score: number }> {
  return received.body.documents
    .map((document, index) => ({ index, relevance_score: document.length }))
    .sort((a, b) => b.relevance_score - a.relevance_score)
}

async function failureOf(promise: Promise<unknown>): Promise<NarsilError> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(outcome).toBeInstanceOf(NarsilError)
  return outcome as NarsilError
}

describe('the HTTP rerank adapter against a live rerank endpoint', () => {
  let server: Server
  let base: string
  let received: Received[]
  let responders: Responder[]

  beforeEach(async () => {
    received = []
    responders = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const entry: Received = {
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }
        received.push(entry)
        const respond = responders.shift() ?? ((r, out) => reply(out, 200, { results: scoreByLength(r) }))
        respond(entry, res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('posts the model, query, and documents and returns each score in document order', async () => {
    const reranker = createHttpReranker({ baseUrl: `${base}/`, model: 'rerank-v3.5', apiKey: 'secret-key' })
    const documents = ['a', 'abcd', 'ab', 'abc']

    const scores = await reranker.rerank('letters', documents)

    expect(scores).toEqual([1, 4, 2, 3])
    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/v2/rerank')
    expect(received[0].authorization).toBe('Bearer secret-key')
    expect(received[0].body).toEqual({ model: 'rerank-v3.5', query: 'letters', documents, top_n: 4 })
  })

  it('splits a long list across requests and keeps every score in place', async () => {
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', maxDocumentsPerRequest: 3 })
    const documents = Array.from({ length: 8 }, (_, i) => 'x'.repeat(i + 1))

    const scores = await reranker.rerank('q', documents)

    expect(scores).toEqual(documents.map(document => document.length))
    expect(received.map(entry => entry.body.documents.length)).toEqual([3, 3, 2])
    expect(received.every(entry => entry.authorization === undefined)).toBe(true)
  })

  it('sends no request for an empty list', async () => {
    const reranker = createHttpReranker({ baseUrl: base, model: 'm' })
    expect(await reranker.rerank('q', [])).toEqual([])
    expect(received).toHaveLength(0)
  })

  it('reads a fresh key from a key function on every call', async () => {
    let issued = 0
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', apiKey: async () => `token-${++issued}` })
    await reranker.rerank('q', ['a'])
    await reranker.rerank('q', ['a'])
    expect(received.map(entry => entry.authorization)).toEqual(['Bearer token-1', 'Bearer token-2'])
  })

  it('retries a rate limit after the wait the service asks for', async () => {
    responders.push((_r, res) => reply(res, 429, { message: 'slow down' }, { 'retry-after': '0.01' }))
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', maxRetries: 2 })

    expect(await reranker.rerank('q', ['ab', 'a'])).toEqual([2, 1])
    expect(received).toHaveLength(2)
  })

  it('stops at a rejected key and keeps the key out of the error', async () => {
    responders.push((_r, res) => reply(res, 401, { message: 'invalid api token' }))
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', apiKey: 'sk-live-do-not-leak', maxRetries: 3 })

    const failure = await failureOf(reranker.rerank('q', ['a']))

    expect(failure.code).toBe(ErrorCodes.RERANK_FAILED)
    expect(failure.details.status).toBe(401)
    expect(failure.message).toContain('invalid api token')
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain('sk-live-do-not-leak')
    expect(received).toHaveLength(1)
  })

  it.each([
    ['no results list', { data: [] }],
    ['too few results', { results: [{ index: 0, relevance_score: 1 }] }],
    [
      'a repeated index',
      {
        results: [
          { index: 0, relevance_score: 1 },
          { index: 0, relevance_score: 2 },
        ],
      },
    ],
    [
      'an index outside the documents',
      {
        results: [
          { index: 0, relevance_score: 1 },
          { index: 2, relevance_score: 2 },
        ],
      },
    ],
    [
      'a score that is not a number',
      {
        results: [
          { index: 0, relevance_score: '0.9' },
          { index: 1, relevance_score: 0.2 },
        ],
      },
    ],
    [
      'a fractional index',
      {
        results: [
          { index: 0.5, relevance_score: 1 },
          { index: 1, relevance_score: 2 },
        ],
      },
    ],
  ])('refuses a reply with %s', async (_label, body) => {
    responders.push((_r, res) => reply(res, 200, body))
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', maxRetries: 0 })

    const failure = await failureOf(reranker.rerank('q', ['a', 'b']))

    expect(failure.code).toBe(ErrorCodes.RERANK_FAILED)
  })

  it('gives up on a body that is not JSON once its retries run out', async () => {
    responders.push((_r, res) => reply(res, 200, 'not json'))
    responders.push((_r, res) => reply(res, 200, 'still not json'))
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', maxRetries: 1 })

    const failure = await failureOf(reranker.rerank('q', ['a']))

    expect(failure.code).toBe(ErrorCodes.RERANK_FAILED)
    expect(received).toHaveLength(2)
  }, 10_000)

  it('aborts a request that outlasts its timeout', async () => {
    responders.push(() => undefined)
    const reranker = createHttpReranker({ baseUrl: base, model: 'm', timeout: 50, maxRetries: 0 })

    await expect(reranker.rerank('q', ['a'])).rejects.toThrow()
  })

  it.each([
    [{ baseUrl: '', model: 'm' }],
    [{ baseUrl: 'api.cohere.com/v2', model: 'm' }],
    [{ baseUrl: 'file:///etc/passwd', model: 'm' }],
    [{ baseUrl: 'https://api.cohere.com/v2', model: ' ' }],
    [{ baseUrl: 'https://api.cohere.com/v2', model: 'm', apiKey: '' }],
    [{ baseUrl: 'https://api.cohere.com/v2', model: 'm', timeout: 0 }],
    [{ baseUrl: 'https://api.cohere.com/v2', model: 'm', maxRetries: -1 }],
    [{ baseUrl: 'https://api.cohere.com/v2', model: 'm', maxDocumentsPerRequest: 0 }],
  ])('refuses the settings %j', settings => {
    expect(() => createHttpReranker(settings)).toThrow(
      expect.objectContaining({ code: ErrorCodes.RERANK_CONFIG_INVALID }),
    )
  })
})
