import { describe, expect, it } from 'vitest'
import { embedDocumentFields } from '../../engine/embed'
import { ErrorCodes, NarsilError } from '../../errors'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { EmbeddingFieldConfig, SchemaDefinition } from '../../types/schema'
import { createFailingAdapter, createMockAdapter, createWrongDimensionAdapter } from './fixtures'

describe('Auto-embedding on insert', () => {
  it('calls adapter.embed and populates the vector field when the document has no vector', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const doc: Record<string, unknown> = { title: 'Machine Learning', body: 'An introduction to ML' }

    await embedDocumentFields(doc, config, adapter)

    expect(adapter.calls.length).toBe(1)
    expect(adapter.calls[0].purpose).toBe('document')
    expect(adapter.calls[0].input).toBe('Machine Learning\nAn introduction to ML')
    expect(doc.embedding).toBeInstanceOf(Float32Array)
    expect((doc.embedding as Float32Array).length).toBe(384)
  })

  it('skips embedding when the document already has a vector value', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const existingVector = new Float32Array(384)
    const doc: Record<string, unknown> = { title: 'Pre-embedded Article', embedding: existingVector }

    await embedDocumentFields(doc, config, adapter)

    expect(adapter.calls.length).toBe(0)
    expect(doc.embedding).toBe(existingVector)
  })

  it('concatenates multiple source fields with newline separator', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const doc: Record<string, unknown> = { title: 'First Part', body: 'Second Part' }

    await embedDocumentFields(doc, config, adapter)

    expect(adapter.calls[0].input).toBe('First Part\nSecond Part')
  })

  it('concatenates only present source fields when some are missing', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const doc: Record<string, unknown> = { title: 'Only Title' }

    await embedDocumentFields(doc, config, adapter)

    expect(adapter.calls[0].input).toBe('Only Title')
  })

  it('throws EMBEDDING_NO_SOURCE when all source fields are missing', async () => {
    const adapter = createMockAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title', 'body'] },
    }
    const doc: Record<string, unknown> = { category: 'test' }

    try {
      await embedDocumentFields(doc, config, adapter)
      expect.fail('Expected error when all source fields are missing')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_NO_SOURCE)
    }
  })

  it('throws EMBEDDING_FAILED when the adapter throws', async () => {
    const adapter = createFailingAdapter(384)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const doc: Record<string, unknown> = { title: 'Test' }

    try {
      await embedDocumentFields(doc, config, adapter)
      expect.fail('Expected error from failing adapter')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_FAILED)
    }
  })

  it('throws EMBEDDING_DIMENSION_MISMATCH when adapter returns wrong dimensions', async () => {
    const adapter = createWrongDimensionAdapter(384, 128)
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { embedding: ['title'] },
    }
    const doc: Record<string, unknown> = { title: 'Test' }

    try {
      await embedDocumentFields(doc, config, adapter)
      expect.fail('Expected error for wrong dimensions')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_DIMENSION_MISMATCH)
    }
  })

  it('cleans up partially embedded fields on failure', async () => {
    let callCount = 0
    const adapter: EmbeddingAdapter = {
      dimensions: 384,
      async embed() {
        callCount++
        if (callCount > 1) throw new Error('Second field fails')
        return new Float32Array(384)
      },
    }
    const _schema: SchemaDefinition = {
      title: 'string' as const,
      body: 'string' as const,
      vec1: 'vector[384]' as const,
      vec2: 'vector[384]' as const,
    }
    const config: EmbeddingFieldConfig = {
      adapter,
      fields: { vec1: 'title', vec2: 'body' },
    }
    const doc: Record<string, unknown> = { title: 'Test', body: 'Content' }

    try {
      await embedDocumentFields(doc, config, adapter)
      expect.fail('Expected error on second embedding')
    } catch {
      expect(doc.vec1).toBeUndefined()
      expect(doc.vec2).toBeUndefined()
    }
  })
})
