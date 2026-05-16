import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import { validateFieldValue } from './field-values'
import { isPlainObject } from './shared'

function validateDocumentFields(doc: Record<string, unknown>, schema: SchemaDefinition, prefix: string): void {
  for (const [field, type] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${field}` : field
    const value = doc[field]

    if (value === undefined || value === null) continue

    if (isPlainObject(type)) {
      if (!isPlainObject(value)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path}" expected an object`, {
          field: path,
          received: Array.isArray(value) ? 'array' : typeof value,
        })
      }
      validateDocumentFields(value, type as SchemaDefinition, path)
      continue
    }

    validateFieldValue(path, value, type as FieldType)
  }
}

export function validateDocument(document: Record<string, unknown>, schema: SchemaDefinition): void {
  if (!isPlainObject(document)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Document must be a plain object', {
      received: typeof document,
    })
  }

  validateDocumentFields(document, schema, '')
}

function collectExtraFields(
  doc: Record<string, unknown>,
  schema: SchemaDefinition,
  prefix: string,
  extras: string[],
): void {
  for (const key of Object.keys(doc)) {
    if (key === 'id') continue
    const path = prefix ? `${prefix}.${key}` : key

    if (!(key in schema)) {
      extras.push(path)
      continue
    }

    const schemaType = schema[key]
    if (isPlainObject(schemaType) && isPlainObject(doc[key])) {
      collectExtraFields(doc[key] as Record<string, unknown>, schemaType as SchemaDefinition, path, extras)
    }
  }
}

export function validateDocumentStrict(document: Record<string, unknown>, schema: SchemaDefinition): void {
  const extras: string[] = []
  collectExtraFields(document, schema, '', extras)

  if (extras.length > 0) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Document contains fields not defined in schema: ${extras.join(', ')}`,
      { extraFields: extras },
    )
  }
}

function resolveNestedValue(document: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return document[path]
  const segments = path.split('.')
  let current: unknown = document
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function validateRequiredFields(document: Record<string, unknown>, required: string[]): void {
  if (required.length === 0) return

  for (const field of required) {
    const value = resolveNestedValue(document, field)
    if (value === undefined || value === null) {
      throw new NarsilError(ErrorCodes.DOC_MISSING_REQUIRED_FIELD, `Document is missing required field "${field}"`, {
        field,
      })
    }
  }
}
