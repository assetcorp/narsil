import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAIEmbedding, type OpenAIEmbeddingConfig } from '../../embeddings/openai'
import { ErrorCodes } from '../../errors'
import { createNarsil } from '../../narsil'

const DIMENSIONS = 4
const LARGEST_REQUEST_INPUTS = 2048

interface ReceivedRequest {
  method: string | undefined
  path: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: { input: string[]; model: string; dimensions: number }
}

type Answer = (request: ReceivedRequest, response: ServerResponse) => void

function vectorFor(text: string): number[] {
  const seed = [...text].reduce((total, letter) => total + letter.charCodeAt(0), 0)
  return Array.from({ length: DIMENSIONS }, (_, position) => (seed + position) / 1000)
}

function answerWithVectors(request: ReceivedRequest, response: ServerResponse): void {
  const data = request.body.input.map((text, index) => ({ index, embedding: vectorFor(text) }))
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ data }))
}

function answerStatus(status: number, body: string): Answer {
  return (_request, response) => {
    response.writeHead(status, { 'Retry-After': '0' })
    response.end(body)
  }
}

describe('the OpenAI adapter against a real HTTP endpoint', () => {
  let server: Server
  let received: ReceivedRequest[]
  let answers: Answer[]
  let baseUrl: string

  beforeEach(async () => {
    received = []
    answers = []
    server = createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        if (incoming.method !== 'POST') {
          response.writeHead(404)
          response.end()
          return
        }
        const request: ReceivedRequest = {
          method: incoming.method,
          path: incoming.url,
          authorization: incoming.headers.authorization,
          contentType: incoming.headers['content-type'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }
        received.push(request)
        const answer = answers.shift() ?? answerWithVectors
        answer(request, response)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  function adapter(settings: Partial<OpenAIEmbeddingConfig> = {}) {
    return createOpenAIEmbedding({
      baseUrl,
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: DIMENSIONS,
      maxRetries: 0,
      timeout: 10_000,
      ...settings,
    })
  }

  it('sends the documented request and returns the vector the endpoint answered with', async () => {
    const vector = await adapter().embed('desk lamp', 'document')

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      method: 'POST',
      path: '/v1/embeddings',
      authorization: 'Bearer sk-test-key',
      contentType: 'application/json',
      body: { input: ['desk lamp'], model: 'text-embedding-3-small', dimensions: DIMENSIONS },
    })
    expect([...vector]).toEqual(vectorFor('desk lamp').map(value => Math.fround(value)))
  })

  it('reaches the same path when the base URL ends in slashes', async () => {
    await adapter({ baseUrl: `${baseUrl}///` }).embed('desk lamp', 'query')
    expect(received[0].path).toBe('/v1/embeddings')
  })

  it('puts batch answers back in input order when the endpoint returns them shuffled', async () => {
    answers.push((request, response) => {
      const data = request.body.input.map((text, index) => ({ index, embedding: vectorFor(text) })).reverse()
      response.end(JSON.stringify({ data }))
    })
    const vectors = (await adapter().embedBatch?.(['first', 'second', 'third'], 'document')) ?? []
    expect(vectors.map(vector => vector[0])).toEqual(
      ['first', 'second', 'third'].map(text => Math.fround(vectorFor(text)[0])),
    )
  })

  it('splits a batch at the request limit and keeps every answer in input order', async () => {
    const inputs = Array.from({ length: LARGEST_REQUEST_INPUTS + 500 }, (_, position) => `text-${position}`)
    const vectors = (await adapter().embedBatch?.(inputs, 'document')) ?? []

    expect(received.map(request => request.body.input.length)).toEqual([LARGEST_REQUEST_INPUTS, 500])
    expect(vectors).toHaveLength(inputs.length)
    vectors.forEach((vector, position) => {
      expect(vector[0]).toBe(Math.fround(vectorFor(inputs[position])[0]))
    })
  })

  it('sends one request for a batch exactly at the limit and none for an empty batch', async () => {
    await adapter().embedBatch?.(
      Array.from({ length: LARGEST_REQUEST_INPUTS }, (_, position) => `text-${position}`),
      'document',
    )
    expect(received).toHaveLength(1)

    received.length = 0
    expect(await adapter().embedBatch?.([], 'document')).toEqual([])
    expect(received).toHaveLength(0)
  })

  it('refuses a batch answer that is missing vectors', async () => {
    answers.push((_request, response) => {
      response.end(JSON.stringify({ data: [{ index: 0, embedding: vectorFor('first') }] }))
    })
    await expect(adapter().embedBatch?.(['first', 'second'], 'document')).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
    })
  })

  it.each([
    ['a rate limit', 429, JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Too many requests' } })],
    ['a gateway timeout', 504, 'Gateway Timeout'],
    ['a 200 holding a gateway error page', 200, '<html>Bad gateway</html>'],
  ])('retries after %s and answers from the next attempt', async (_label, status, body) => {
    answers.push(answerStatus(status, body))
    const vector = await adapter({ maxRetries: 1 }).embed('desk lamp', 'document')
    expect(received).toHaveLength(2)
    expect(vector).toHaveLength(DIMENSIONS)
  })

  it('names the invalid body once retries run out', async () => {
    answers.push(answerStatus(200, 'not json'))
    await expect(adapter().embed('desk lamp', 'document')).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
      message: expect.stringContaining('invalid JSON'),
    })
    expect(received).toHaveLength(1)
  })

  it('fails at once on a request the endpoint rejects as invalid', async () => {
    answers.push(
      answerStatus(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'Bad request' } })),
    )
    await expect(adapter({ maxRetries: 3 }).embed('desk lamp', 'document')).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
      message: expect.stringContaining('400'),
    })
    expect(received).toHaveLength(1)
  })

  it('reads the key again for each request', async () => {
    const keys = ['key-first-call', 'key-second-call']
    const rotating = adapter({ apiKey: () => keys[received.length] })
    await rotating.embed('first call', 'document')
    await rotating.embed('second call', 'document')
    expect(received.map(request => request.authorization)).toEqual(['Bearer key-first-call', 'Bearer key-second-call'])
  })

  it('keeps the key out of the error when the endpoint fails', async () => {
    const secret = 'sk-super-secret-key-do-not-leak'
    answers.push(answerStatus(500, JSON.stringify({ error: { type: 'server_error', message: 'Internal failure' } })))
    const failure = await adapter({ apiKey: secret })
      .embed('desk lamp', 'document')
      .catch((error: unknown) => error)
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(secret)
    expect(failure).toMatchObject({ message: expect.stringContaining('500') })
  })

  it('makes a document findable through the public API with the vector the endpoint returned', async () => {
    const narsil = await createNarsil({ workers: { enabled: false } })
    try {
      await narsil.registerEmbeddingAdapter('endpoint', adapter())
      await narsil.createIndex('products', {
        schema: { title: 'string', embedding: `vector[${DIMENSIONS}]` },
        embedding: { adapter: 'endpoint', fields: { embedding: 'title' } },
      })
      await narsil.insert('products', { title: 'desk lamp' }, 'lamp')
      const result = await narsil.query('products', {
        mode: 'vector',
        limit: 1,
        vector: { field: 'embedding', text: 'desk lamp' },
      })
      expect(result.hits.map(hit => hit.id)).toEqual(['lamp'])
    } finally {
      await narsil.shutdown()
    }
  })
})
