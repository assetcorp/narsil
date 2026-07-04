import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIEmbedding } from '../../embeddings/openai'
import { ErrorCodes, NarsilError } from '../../errors'

describe('OpenAI adapter HTTP interactions (mocked fetch)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct HTTP request for embed()', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key-123',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    const result = await adapter.embed('hello world', 'document')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(init?.method).toBe('POST')

    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test-key-123')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(init?.body as string)
    expect(body.input).toEqual(['hello world'])
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.dimensions).toBe(1536)

    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(1536)
  })

  it('sends batch input and returns results sorted by index', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: Array.from({ length: 1536 }, () => 0.2) },
            { index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    if (!adapter.embedBatch) throw new Error('expected adapter.embedBatch to be defined')
    const results = await adapter.embedBatch(['first', 'second'], 'document')

    expect(results.length).toBe(2)
    expect(results[0][0]).toBeCloseTo(0.1, 5)
    expect(results[1][0]).toBeCloseTo(0.2, 5)

    const body = JSON.parse((mockFetch.mock.calls[0][1]?.body as string) ?? '{}')
    expect(body.input).toEqual(['first', 'second'])
  })

  it('retries on 429 and succeeds on the next attempt', async () => {
    let callCount = 0
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Too many requests' } }),
            { status: 429, headers: { 'Retry-After': '0' } },
          )
        }
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.5) }],
          }),
          { status: 200 },
        )
      })
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 1,
      timeout: 10_000,
    })

    const result = await adapter.embed('retry test', 'document')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(1536)
  })

  it('retries when a 2xx response carries an unparseable body and succeeds on the next attempt', async () => {
    let callCount = 0
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return new Response('<html>Bad gateway</html>', { status: 200 })
        }
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.3) }],
          }),
          { status: 200 },
        )
      })
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 1,
      timeout: 10_000,
    })

    const result = await adapter.embed('truncated body test', 'document')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(1536)
  })

  it('fails with the invalid-JSON error once retries are exhausted', async () => {
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => new Response('not json', { status: 200 }))
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    try {
      await adapter.embed('always invalid', 'document')
      expect.fail('Expected error for unparseable response body')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_FAILED)
      expect((err as NarsilError).message).toContain('invalid JSON')
    }

    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('does not retry on 400 and fails immediately', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Bad request' } }), {
        status: 400,
      }),
    )
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 3,
    })

    try {
      await adapter.embed('bad request test', 'document')
      expect.fail('Expected error for 400 response')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_FAILED)
      expect((err as NarsilError).message).toContain('400')
    }

    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('resolves apiKey from a function on each request', async () => {
    const keyValues = ['key-first-call', 'key-second-call']
    let keyIndex = 0
    const keyFn = vi.fn(() => {
      const key = keyValues[keyIndex]
      keyIndex++
      return key
    })

    const responseBody = JSON.stringify({
      data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
    })
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => new Response(responseBody, { status: 200 }))
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: keyFn,
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    await adapter.embed('first call', 'document')
    await adapter.embed('second call', 'document')

    expect(keyFn).toHaveBeenCalledTimes(2)
    const firstCallHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>
    const secondCallHeaders = mockFetch.mock.calls[1][1]?.headers as Record<string, string>
    expect(firstCallHeaders.Authorization).toBe('Bearer key-first-call')
    expect(secondCallHeaders.Authorization).toBe('Bearer key-second-call')
  })

  it('wraps API errors without exposing the API key in the error message', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'server_error', message: 'Internal failure' } }), {
        status: 500,
      }),
    )
    globalThis.fetch = mockFetch

    const secretKey = 'sk-super-secret-key-do-not-leak'
    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secretKey,
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    try {
      await adapter.embed('test', 'document')
      expect.fail('Expected error from server error response')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      const errorMessage = (err as NarsilError).message
      expect(errorMessage).not.toContain(secretKey)
      expect(errorMessage).toContain('500')
    }
  })

  it('strips trailing slashes from baseUrl before appending /embeddings', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
        }),
        { status: 200 },
      ),
    )
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxRetries: 0,
    })

    await adapter.embed('test', 'document')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
  })

  it('returns empty array from embedBatch when given empty inputs', async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    })

    const results = await adapter.embedBatch?.([], 'document')

    expect(results).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('chunks large batches into multiple requests of at most 2048 inputs', async () => {
    const dims = 4
    let callCount = 0
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async (_url, init) => {
        callCount++
        const body = JSON.parse(init?.body as string) as { input: string[] }
        const data = body.input.map((_, idx) => ({
          index: idx,
          embedding: Array.from({ length: dims }, () => callCount + idx * 0.001),
        }))
        return new Response(JSON.stringify({ data }), { status: 200 })
      })
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: dims,
      maxRetries: 0,
    })

    const totalInputs = 2048 + 500
    const inputs = Array.from({ length: totalInputs }, (_, i) => `text-${i}`)
    expect(adapter.embedBatch).toBeDefined()
    const results = (await adapter.embedBatch?.(inputs, 'document')) ?? []

    expect(mockFetch).toHaveBeenCalledTimes(2)

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string) as { input: string[] }
    expect(firstBody.input.length).toBe(2048)

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1]?.body as string) as { input: string[] }
    expect(secondBody.input.length).toBe(500)

    expect(results.length).toBe(totalInputs)
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(dims)
    }
  })

  it('sends a single request when batch size is exactly 2048', async () => {
    const dims = 4
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] }
        const data = body.input.map((_, idx) => ({
          index: idx,
          embedding: Array.from({ length: dims }, () => 0.1),
        }))
        return new Response(JSON.stringify({ data }), { status: 200 })
      })
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: dims,
      maxRetries: 0,
    })

    const inputs = Array.from({ length: 2048 }, (_, i) => `text-${i}`)
    expect(adapter.embedBatch).toBeDefined()
    const results = (await adapter.embedBatch?.(inputs, 'document')) ?? []

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(results.length).toBe(2048)
  })
})
