import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil } from '../../narsil'
import { validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateRequiredFields } from '../../schema/validator'
import { createMockAdapter, vectorSchema } from './fixtures'

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

  it('rejects an update that lacks a required field before it asks the adapter for an embedding', async () => {
    const adapter = createMockAdapter()
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      required: ['title'],
      embedding: { adapter, fields: { embedding: 'body' } },
    })
    await narsil.insert('articles', { title: 'Harbour tides', body: 'The tide turns twice a day' }, 'a1')
    const callsAfterInsert = adapter.calls.length

    await expect(narsil.update('articles', 'a1', { body: 'A body with no title' })).rejects.toMatchObject({
      code: ErrorCodes.DOC_MISSING_REQUIRED_FIELD,
    })
    expect(adapter.calls.length).toBe(callsAfterInsert)
    await narsil.shutdown()
  })
})
