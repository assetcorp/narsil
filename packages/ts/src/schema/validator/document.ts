import { ErrorCodes, NarsilError } from '../../errors'
import type { SchemaDefinition } from '../../types/schema'
import { DEFAULT_PATTERN_VALUE_LIMIT } from '../constants'
import { type ParsedFieldType, parseFieldType } from './field-type'
import { validateFieldValue } from './field-values'
import { isPlainObject, VECTOR_PATTERN } from './shared'
import { assertStorableDocument } from './storable'

const vectorPathCache = new WeakMap<SchemaDefinition, Set<string>>()

function vectorFieldPaths(schema: SchemaDefinition): Set<string> {
  let paths = vectorPathCache.get(schema)
  if (paths !== undefined) return paths
  paths = new Set()
  const collect = (level: SchemaDefinition, prefix: string): void => {
    for (const [field, type] of Object.entries(level)) {
      const path = prefix === '' ? field : `${prefix}.${field}`
      if (typeof type === 'string' && VECTOR_PATTERN.test(type)) {
        paths?.add(path)
      } else if (isPlainObject(type)) {
        collect(type as SchemaDefinition, path)
      }
    }
  }
  collect(schema, '')
  vectorPathCache.set(schema, paths)
  return paths
}

interface SchemaLevelEntry {
  field: string
  nested: SchemaDefinition | null
  type: ParsedFieldType | null
}

const parsedLevelCache = new WeakMap<SchemaDefinition, SchemaLevelEntry[]>()

function parsedLevel(schema: SchemaDefinition, prefix: string): SchemaLevelEntry[] {
  let entries = parsedLevelCache.get(schema)
  if (entries !== undefined) return entries
  entries = Object.entries(schema).map(([field, type]) => {
    if (isPlainObject(type)) return { field, nested: type as SchemaDefinition, type: null }
    const path = prefix ? `${prefix}.${field}` : field
    return { field, nested: null, type: parseFieldType(type as string, path) }
  })
  parsedLevelCache.set(schema, entries)
  return entries
}

function validateDocumentFields(
  doc: Record<string, unknown>,
  schema: SchemaDefinition,
  prefix: string,
  patternValueLimit: number,
): void {
  for (const { field, nested, type } of parsedLevel(schema, prefix)) {
    const value = doc[field]

    if (value === undefined || value === null) continue

    const path = prefix ? `${prefix}.${field}` : field
    if (nested !== null) {
      if (!isPlainObject(value)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path}" expected an object`, {
          field: path,
          received: Array.isArray(value) ? 'array' : typeof value,
        })
      }
      validateDocumentFields(value, nested, path, patternValueLimit)
      continue
    }

    if (type !== null) validateFieldValue(path, value, type, patternValueLimit)
  }
}

export function validateDocument(
  document: Record<string, unknown>,
  schema: SchemaDefinition,
  patternValueLimit: number = DEFAULT_PATTERN_VALUE_LIMIT,
): void {
  if (!isPlainObject(document)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Document must be a plain object', {
      received: typeof document,
    })
  }

  assertStorableDocument(document, vectorFieldPaths(schema))
  validateDocumentFields(document, schema, '', patternValueLimit)
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

    if (!Object.hasOwn(schema, key)) {
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
