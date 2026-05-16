import { describe, expect, it } from 'vitest'
import { embedBatchDocumentFields } from '../../engine/embed'
import { ErrorCodes, NarsilError } from '../../errors'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { EmbeddingFieldConfig } from '../../types/schema'
import { createMockAdapter } from './fixtures'

describe('Batch embedding on insertBatch', () => {
  it('calls embedBatch when the adapter provides it', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const docs: Record<string, unknown>[] = [
      { title: 'Document One' },
      { title: 'Document Two' },
      { title: 'Document Three' },
    ]

    await embedBatchDocumentFields(docs, config, adapter)

    expect(adapter.calls.length).toBe(3)
    for (const doc of docs) {
      expect(doc.embedding).toBeInstanceOf(Float32Array)
    }
  })

  it('falls back to individual embed() calls when embedBatch is not provided', async () => {
    const calls: string[] = []
    const adapter: EmbeddingAdapter = {
      dimensions: 384,
      async embed(input, _purpose) {
        calls.push(input)
        return new Float32Array(384)
      },
    }
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const docs: Record<string, unknown>[] = [{ title: 'Doc A' }, { title: 'Doc B' }]

    await embedBatchDocumentFields(docs, config, adapter)

    expect(calls).toEqual(['Doc A', 'Doc B'])
    for (const doc of docs) {
      expect(doc.embedding).toBeInstanceOf(Float32Array)
    }
  })

  it('throws when adapter fails during batch embedding', async () => {
    const adapter: EmbeddingAdapter = {
      dimensions: 384,
      async embed() {
        throw new Error('Batch embed failed')
      },
      async embedBatch() {
        throw new Error('Batch embed failed')
      },
    }
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const docs: Record<string, unknown>[] = [{ title: 'Doc A' }, { title: 'Doc B' }]

    try {
      await embedBatchDocumentFields(docs, config, adapter)
      expect.fail('Expected error from failing batch adapter')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_FAILED)
    }
  })

  it('batch insert with one document missing all source fields succeeds for other documents', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const docs: Record<string, unknown>[] = [
      { title: 'Valid First', body: 'Has both fields' },
      { category: 'orphan' },
      { title: 'Valid Third', body: 'Also has both fields' },
    ]

    const result = await embedBatchDocumentFields(docs, config, adapter)

    expect(result.embedded.size).toBe(2)
    expect(result.embedded.has(0)).toBe(true)
    expect(result.embedded.has(2)).toBe(true)
    expect(docs[0].embedding).toBeInstanceOf(Float32Array)
    expect(docs[2].embedding).toBeInstanceOf(Float32Array)

    expect(result.failed.size).toBe(1)
    expect(result.failed.has(1)).toBe(true)
    const failedError = result.failed.get(1)
    expect(failedError).toBeInstanceOf(NarsilError)
    expect(failedError?.code).toBe(ErrorCodes.EMBEDDING_NO_SOURCE)

    expect(docs[1].embedding).toBeUndefined()
    expect(adapter.calls.length).toBe(2)
  })

  it('isolates documents with missing source fields as individual failures without blocking the batch', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const docs: Record<string, unknown>[] = [{ title: 'Has Title' }, { category: 'has-nothing-useful' }]

    const result = await embedBatchDocumentFields(docs, config, adapter)

    expect(result.failed.size).toBe(1)
    expect(result.failed.has(1)).toBe(true)
    const failedError = result.failed.get(1)
    expect(failedError).toBeInstanceOf(NarsilError)
    expect(failedError?.code).toBe(ErrorCodes.EMBEDDING_NO_SOURCE)

    expect(result.embedded.has(0)).toBe(true)
    expect(docs[0].embedding).toBeInstanceOf(Float32Array)
  })

  it('cleans up all embedded fields when batch embedding fails partway through', async () => {
    const adapter: EmbeddingAdapter = {
      dimensions: 384,
      async embed() {
        return new Float32Array(384)
      },
      async embedBatch() {
        throw new Error('Batch crashed mid-flight')
      },
    }
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const docs: Record<string, unknown>[] = [{ title: 'Doc A' }, { title: 'Doc B' }]

    try {
      await embedBatchDocumentFields(docs, config, adapter)
    } catch {
      for (const doc of docs) {
        expect(doc.embedding).toBeUndefined()
      }
    }
  })
})
