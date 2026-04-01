import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIEmbedding } from '../embeddings/openai'
import { embedBatchDocumentFields, embedDocumentFields } from '../engine/embed'
import { ErrorCodes, NarsilError } from '../errors'
import { createNarsil, type Narsil } from '../narsil'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from '../schema/embedding-validator'
import { validateRequiredFields } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { EmbeddingFieldConfig, SchemaDefinition } from '../types/schema'

function createMockAdapter(
  dimensions: number = 384,
): EmbeddingAdapter & { calls: Array<{ input: string; purpose: string }> } {
  const calls: Array<{ input: string; purpose: string }> = []
  return {
    dimensions,
    calls,
    async embed(input, purpose) {
      calls.push({ input, purpose })
      const vec = new Float32Array(dimensions)
      for (let i = 0; i < dimensions; i++) vec[i] = Math.random()
      return vec
    },
    async embedBatch(inputs, purpose) {
      return inputs.map(input => {
        calls.push({ input, purpose })
        const vec = new Float32Array(dimensions)
        for (let i = 0; i < dimensions; i++) vec[i] = Math.random()
        return vec
      })
    },
  }
}

function createFailingAdapter(dimensions: number = 384): EmbeddingAdapter {
  return {
    dimensions,
    async embed() {
      throw new Error('Adapter crashed')
    },
  }
}

function createWrongDimensionAdapter(reportedDimensions: number, actualDimensions: number): EmbeddingAdapter {
  return {
    dimensions: reportedDimensions,
    async embed(_input, _purpose) {
      return new Float32Array(actualDimensions)
    },
  }
}

const vectorSchema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  embedding: 'vector[384]' as const,
}

const vectorSchemaWithCategory: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  category: 'enum' as const,
  embedding: 'vector[384]' as const,
}

describe('Embedding System', () => {
  describe('EmbeddingAdapter config validation (createIndex)', () => {
    it('accepts valid embedding config with adapter and matching schema', () => {
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { embedding: ['title', 'body'] },
      }
      const resolved = validateEmbeddingConfig(config, vectorSchema, undefined)
      expect(resolved).toBe(adapter)
    })

    it('throws EMBEDDING_CONFIG_INVALID when target field does not exist in schema', () => {
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { nonexistent: ['title'] },
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for non-existent target field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('throws EMBEDDING_CONFIG_INVALID when target field is not a vector type', () => {
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { title: ['body'] },
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for non-vector target field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('throws EMBEDDING_CONFIG_INVALID when source field does not exist in schema', () => {
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { embedding: ['nonexistent_field'] },
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for non-existent source field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('throws EMBEDDING_CONFIG_INVALID when source field is not a string type', () => {
      const schema: SchemaDefinition = {
        title: 'string' as const,
        count: 'number' as const,
        embedding: 'vector[384]' as const,
      }
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { embedding: ['count'] },
      }
      try {
        validateEmbeddingConfig(config, schema, undefined)
        expect.fail('Expected error for non-string source field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('throws EMBEDDING_DIMENSION_MISMATCH when adapter dimensions differ from schema vector dimensions', () => {
      const adapter = createMockAdapter(768)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: { embedding: ['title'] },
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for dimension mismatch')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_DIMENSION_MISMATCH)
      }
    })

    it('throws EMBEDDING_CONFIG_INVALID when no adapter is provided at index or instance level', () => {
      const config: EmbeddingFieldConfig = {
        fields: { embedding: ['title'] },
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for missing adapter')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('falls back to instance-level adapter when index-level adapter is not set', () => {
      const instanceAdapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        fields: { embedding: ['title'] },
      }
      const resolved = validateEmbeddingConfig(config, vectorSchema, instanceAdapter)
      expect(resolved).toBe(instanceAdapter)
    })

    it('throws EMBEDDING_CONFIG_INVALID when fields mapping is empty', () => {
      const adapter = createMockAdapter(384)
      const config: EmbeddingFieldConfig = {
        adapter,
        fields: {},
      }
      try {
        validateEmbeddingConfig(config, vectorSchema, undefined)
        expect.fail('Expected error for empty fields mapping')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })
  })

  describe('Required fields validation', () => {
    it('passes when document has all required fields', () => {
      const doc = { title: 'Test Article', body: 'Some content here' }
      expect(() => validateRequiredFields(doc, ['title', 'body'])).not.toThrow()
    })

    it('throws DOC_MISSING_REQUIRED_FIELD when a required field is missing', () => {
      const doc = { title: 'Test Article' }
      try {
        validateRequiredFields(doc, ['title', 'body'])
        expect.fail('Expected error for missing required field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.DOC_MISSING_REQUIRED_FIELD)
      }
    })

    it('throws DOC_MISSING_REQUIRED_FIELD when a required field is null', () => {
      const doc = { title: 'Test Article', body: null }
      try {
        validateRequiredFields(doc, ['title', 'body'])
        expect.fail('Expected error for null required field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.DOC_MISSING_REQUIRED_FIELD)
      }
    })

    it('throws EMBEDDING_CONFIG_INVALID when required array references a field not in the schema', () => {
      try {
        validateRequiredFieldsInSchema(['nonexistent_field'], vectorSchema)
        expect.fail('Expected error for non-existent required field')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      }
    })

    it('runs no validation when the required array is empty', () => {
      const doc = {}
      expect(() => validateRequiredFields(doc, [])).not.toThrow()
    })
  })

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
        { title: 'Valid Doc', body: 'Has body' },
        { category: 'tech' },
      ])

      expect(result.succeeded.length).toBe(1)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].error.code).toBe(ErrorCodes.EMBEDDING_NO_SOURCE)
    })
  })

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

  describe('OpenAI adapter', () => {
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

    describe('HTTP interactions (mocked fetch)', () => {
      const originalFetch = globalThis.fetch

      afterEach(() => {
        globalThis.fetch = originalFetch
      })

      it('sends correct HTTP request for embed()', async () => {
        const mockFetch = vi
          .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
          .mockResolvedValue(
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
        const mockFetch = vi
          .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
          .mockResolvedValue(
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

        const results = await adapter.embedBatch?.(['first', 'second'], 'document')

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

      it('does not retry on 400 and fails immediately', async () => {
        const mockFetch = vi
          .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
          .mockResolvedValue(
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
        const mockFetch = vi
          .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
          .mockResolvedValue(
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
        const mockFetch = vi
          .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
          .mockResolvedValue(
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
  })
})
