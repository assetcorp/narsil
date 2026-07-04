import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { createFailingAdapter, createMockAdapter, vectorSchema, vectorSchemaWithCategory } from './fixtures'

describe('Integration: embedding through Narsil insert/query', () => {
  let narsil: Narsil

  afterEach(async () => {
    if (narsil) await narsil.shutdown()
  })

  it('auto-embeds documents on insert when embedding config is present', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title', 'body'] },
      },
    })

    await narsil.insert('articles', { title: 'Neural Networks', body: 'Deep learning primer' })

    expect(adapter.calls.length).toBe(1)
    expect(adapter.calls[0].purpose).toBe('document')
    expect(adapter.calls[0].input).toBe('Neural Networks\nDeep learning primer')
  })

  it('skips embedding when the document provides its own vector', async () => {
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

    const precomputed = new Float32Array(384).fill(0.5)
    await narsil.insert('articles', { title: 'Pre-embedded', embedding: precomputed })

    expect(adapter.calls.length).toBe(0)
  })

  it('uses instance-level adapter as fallback during createIndex', async () => {
    const instanceAdapter = createMockAdapter(384)
    narsil = await createNarsil({ embedding: instanceAdapter })
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        fields: { embedding: ['title'] },
      },
    })

    await narsil.insert('articles', { title: 'Fallback test' })

    expect(instanceAdapter.calls.length).toBe(1)
  })

  it('validates required fields before embedding on insert', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title'] },
      },
      required: ['title', 'body'],
    })

    try {
      await narsil.insert('articles', { title: 'No body provided' })
      expect.fail('Expected error for missing required field')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.DOC_MISSING_REQUIRED_FIELD)
    }
    expect(adapter.calls.length).toBe(0)
  })

  it('auto-embeds documents during batch insert', async () => {
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

    const result = await narsil.insertBatch('articles', [
      { title: 'Batch Doc One' },
      { title: 'Batch Doc Two' },
      { title: 'Batch Doc Three' },
    ])

    expect(result.succeeded.length).toBe(3)
    expect(result.failed.length).toBe(0)
    expect(adapter.calls.length).toBe(3)
  })

  it('reports documents with missing source fields as batch failures while succeeding for valid documents', async () => {
    const adapter = createMockAdapter(384)
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchemaWithCategory,
      language: 'english',
      embedding: {
        adapter,
        fields: { embedding: ['title', 'body'] },
      },
    })

    const result = await narsil.insertBatch('articles', [
      { id: 'doc-valid', title: 'Valid Doc', body: 'Has body' },
      { id: 'doc-no-source', category: 'tech' },
    ])

    expect(result.succeeded).toEqual(['doc-valid'])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].docId).toBe('doc-no-source')
    expect(result.failed[0].error.code).toBe(ErrorCodes.EMBEDDING_NO_SOURCE)
  })

  it('carries provided document ids on failed entries when the adapter crashes during batch embedding', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      language: 'english',
      embedding: {
        adapter: createFailingAdapter(384),
        fields: { embedding: ['title'] },
      },
    })

    const result = await narsil.insertBatch('articles', [
      { id: 'crash-one', title: 'First document' },
      { title: 'Document without an id' },
    ])

    expect(result.succeeded.length).toBe(0)
    expect(result.failed.length).toBe(2)
    expect(result.failed[0].docId).toBe('crash-one')
    expect(result.failed[0].error.code).toBe(ErrorCodes.EMBEDDING_FAILED)
    expect(result.failed[1].docId).toBe('')
    expect(result.failed[1].error.code).toBe(ErrorCodes.EMBEDDING_FAILED)
  })
})
