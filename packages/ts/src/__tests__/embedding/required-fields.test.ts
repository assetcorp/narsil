import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateRequiredFields } from '../../schema/validator'
import { vectorSchema } from './fixtures'

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
