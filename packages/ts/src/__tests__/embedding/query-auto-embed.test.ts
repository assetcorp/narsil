import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { createMockAdapter, vectorSchema } from './fixtures'

describe('Query text auto-embedding', () => {
  let narsil: Narsil

  afterEach(async () => {
    if (narsil) await narsil.shutdown()
  })

  it('embeds query text using the adapter with purpose=query', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title'] },
      },
    })

    await narsil.insert('articles', { title: 'Transformers in NLP' })

    const result = await narsil.query('articles', {
      vector: { field: 'embedding', text: 'natural language processing' },
    })

    const queryCalls = adapter.calls.filter(c => c.purpose === 'query')
    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0].input).toBe('natural language processing')
    expect(result.hits).toBeDefined()
  })

  it('uses vector value directly without calling the adapter', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title'] },
      },
    })

    await narsil.insert('articles', { title: 'Test Document' })

    const queryVector = Array.from(new Float32Array(384).fill(0.1))
    await narsil.query('articles', {
      vector: { field: 'embedding', value: queryVector },
    })

    const queryCalls = adapter.calls.filter(c => c.purpose === 'query')
    expect(queryCalls.length).toBe(0)
  })

  it('throws EMBEDDING_CONFIG_INVALID when both text and value are provided', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title'] },
      },
    })

    try {
      await narsil.query('articles', {
        vector: {
          field: 'embedding',
          text: 'some text',
          value: Array.from(new Float32Array(384)),
        },
      })
      expect.fail('Expected error when both text and value are provided')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('throws EMBEDDING_CONFIG_INVALID when query uses text but no adapter is available', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
    })

    try {
      await narsil.query('articles', {
        vector: { field: 'embedding', text: 'query without adapter' },
      })
      expect.fail('Expected error for text query without adapter')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
    }
  })

  it('handles hybrid query with text-based vector embedding alongside BM25', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title'] },
      },
    })

    await narsil.insert('articles', { title: 'Attention Is All You Need', body: 'Transformer architecture paper' })

    const result = await narsil.query('articles', {
      term: 'transformer',
      mode: 'hybrid',
      vector: { field: 'embedding', text: 'transformer model architecture' },
    })

    const queryCalls = adapter.calls.filter(c => c.purpose === 'query')
    expect(queryCalls.length).toBe(1)
    expect(result.hits).toBeDefined()
  })
})
