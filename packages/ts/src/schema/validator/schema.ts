import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import { MAX_NESTING_DEPTH } from '../constants'
import { type ParsedFieldType, parseFieldType } from './field-type'
import { FIELD_NAME_PATTERN, isPlainObject, PROTOTYPE_POLLUTION_KEYS, RESERVED_ROOT_FIELDS } from './shared'

export interface SchemaField extends ParsedFieldType {
  readonly path: string
}

function validateSchemaFields(schema: SchemaDefinition, depth: number, prefix: string): SchemaDefinition {
  if (depth > MAX_NESTING_DEPTH) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_DEPTH_EXCEEDED,
      `Schema nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH} at "${prefix}"`,
      { path: prefix, maxDepth: MAX_NESTING_DEPTH },
    )
  }

  let canonical: SchemaDefinition | null = null
  const replace = (field: string, value: FieldType | SchemaDefinition): void => {
    if (canonical === null) canonical = { ...schema }
    canonical[field] = value
  }

  for (const [field, type] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${field}` : field

    if (PROTOTYPE_POLLUTION_KEYS.has(field)) {
      throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, `Field name "${field}" is not allowed in a schema`, {
        field,
        path,
      })
    }

    if (!FIELD_NAME_PATTERN.test(field)) {
      throw new NarsilError(
        ErrorCodes.SCHEMA_INVALID_TYPE,
        `Field name "${field}" contains characters that are not allowed; use letters, digits, and underscores only`,
        { field, path },
      )
    }

    if (depth === 1 && RESERVED_ROOT_FIELDS.has(field)) {
      throw new NarsilError(
        ErrorCodes.SCHEMA_INVALID_TYPE,
        `Field "${field}" is reserved and cannot be defined in a schema`,
        { field, path },
      )
    }

    if (isPlainObject(type)) {
      const nested = validateSchemaFields(type as SchemaDefinition, depth + 1, path)
      if (nested !== type) replace(field, nested)
      continue
    }

    if (typeof type !== 'string') {
      throw new NarsilError(
        ErrorCodes.SCHEMA_INVALID_TYPE,
        `Field "${path}" has an invalid type definition: ${String(type)}`,
        {
          field: path,
          type: String(type),
        },
      )
    }

    const parsed = parseFieldType(type, path)
    if (parsed.type !== type) replace(field, parsed.type)
  }

  return canonical ?? schema
}

export function validateSchema(schema: SchemaDefinition): SchemaDefinition {
  if (!isPlainObject(schema)) {
    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Schema must be a plain object', {
      received: typeof schema,
    })
  }

  if (Object.keys(schema).length === 0) {
    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Schema must define at least one field')
  }

  return validateSchemaFields(schema, 1, '')
}

export function requireValidFieldTypes(flatSchema: Readonly<Record<string, unknown>>): void {
  for (const [path, type] of Object.entries(flatSchema)) {
    if (typeof type !== 'string') {
      throw new NarsilError(
        ErrorCodes.SCHEMA_INVALID_TYPE,
        `Field "${path}" has an invalid type definition: ${String(type)}`,
        { field: path, type: String(type) },
      )
    }
    parseFieldType(type, path)
  }
}

function flattenRecursive(schema: SchemaDefinition, prefix: string, result: Record<string, FieldType>): void {
  for (const [field, type] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${field}` : field
    if (isPlainObject(type)) {
      flattenRecursive(type as SchemaDefinition, path, result)
    } else {
      result[path] = type as FieldType
    }
  }
}

const flattenedSchemas = new WeakMap<SchemaDefinition, Readonly<Record<string, FieldType>>>()

export function flattenSchema(schema: SchemaDefinition): Record<string, FieldType> {
  const cached = flattenedSchemas.get(schema)
  if (cached !== undefined) return cached
  const result: Record<string, FieldType> = Object.create(null)
  flattenRecursive(schema, '', result)
  flattenedSchemas.set(schema, Object.freeze(result))
  return result
}

const parsedSchemas = new WeakMap<SchemaDefinition, readonly SchemaField[]>()

export function schemaFieldsOf(schema: SchemaDefinition): readonly SchemaField[] {
  const cached = parsedSchemas.get(schema)
  if (cached !== undefined) return cached
  const fields: SchemaField[] = []
  for (const [path, type] of Object.entries(flattenSchema(schema))) {
    fields.push({ ...parseFieldType(type, path), path })
  }
  const frozen = Object.freeze(fields)
  parsedSchemas.set(schema, frozen)
  return frozen
}

export function extractVectorFieldsFromSchema(schema: SchemaDefinition): Map<string, number> {
  const result = new Map<string, number>()
  for (const field of schemaFieldsOf(schema)) {
    if (field.base === 'vector') result.set(field.path, field.dimension)
  }
  return result
}
