import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { validateEmbeddingConfig } from '../../schema/embedding-validator'
import type { EmbeddingFieldConfig, SchemaDefinition } from '../../types/schema'
import { createMockAdapter, vectorSchema } from './fixtures'

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
