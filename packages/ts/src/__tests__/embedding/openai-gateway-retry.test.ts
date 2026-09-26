import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIEmbedding } from '../../embeddings/openai'

describe('OpenAI adapter behind a gateway (mocked fetch)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries on a 504 from a gateway and succeeds on the next attempt', async () => {
    let callCount = 0
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return new Response('Gateway Timeout', { status: 504, headers: { 'Retry-After': '0' } })
        }
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 8 }, () => 0.5) }] }), {
          status: 200,
        })
      })
    globalThis.fetch = mockFetch

    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      dimensions: 8,
      maxRetries: 1,
      timeout: 10_000,
    })

    const result = await adapter.embed('gateway timeout', 'query')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result.length).toBe(8)
  })
})
