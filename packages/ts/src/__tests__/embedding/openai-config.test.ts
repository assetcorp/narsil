import { describe, expect, it } from 'vitest'
import { createOpenAIEmbedding } from '../../embeddings/openai'
import { ErrorCodes, NarsilError } from '../../errors'

describe('OpenAI adapter config', () => {
  it('creates an adapter with correct dimensions from valid config', () => {
    const adapter = createOpenAIEmbedding({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    })

    expect(adapter.dimensions).toBe(1536)
    expect(adapter.embed).toBeDefined()
    expect(adapter.embedBatch).toBeDefined()
  })

  it('throws EMBEDDING_CONFIG_INVALID for empty baseUrl', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: '',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      })
      expect.fail('Expected error for empty baseUrl')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for empty model', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: '',
        dimensions: 1536,
      })
      expect.fail('Expected error for empty model')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for zero dimensions', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: 0,
      })
      expect.fail('Expected error for zero dimensions')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for negative dimensions', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: -5,
      })
      expect.fail('Expected error for negative dimensions')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for non-integer dimensions', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: 15.5,
      })
      expect.fail('Expected error for non-integer dimensions')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for invalid timeout', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        timeout: -1,
      })
      expect.fail('Expected error for invalid timeout')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID for invalid maxRetries', () => {
    try {
      createOpenAIEmbedding({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        maxRetries: -1,
      })
      expect.fail('Expected error for invalid maxRetries')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })
})
