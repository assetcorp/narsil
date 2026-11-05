import { compareCodePoints } from '../../core/ordering'
import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import { MAX_NESTING_DEPTH, MAX_TEXT_FIELDS, MAX_VECTOR_DIMENSION } from '../constants'
import { isWordIndexedBase, type ParsedFieldType, parseFieldType } from './field-type'
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

  const validated = validateSchemaFields(schema, 1, '')
  requireTextFieldCount(schemaFieldsOf(validated).filter(field => isWordIndexedBase(field.base)).length)
  return validated
}

function requireTextFieldCount(count: number): void {
  if (count <= MAX_TEXT_FIELDS) return
  throw new NarsilError(
    ErrorCodes.SCHEMA_INVALID_TYPE,
    `The schema declares ${count} string and string[] fields, but a schema holds at most ${MAX_TEXT_FIELDS}`,
    { textFields: count, maximum: MAX_TEXT_FIELDS },
  )
}

export function requireCreatableSchema(schema: SchemaDefinition): void {
  for (const field of schemaFieldsOf(schema)) {
    if (field.base !== 'vector' || field.dimension <= MAX_VECTOR_DIMENSION) continue
    throw new NarsilError(
      ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
      `Vector field "${field.path}" has ${field.dimension} dimensions, but a new index takes at most ${MAX_VECTOR_DIMENSION}`,
      { field: field.path, dimension: field.dimension, maximum: MAX_VECTOR_DIMENSION },
    )
  }
}

export function requireValidFieldTypes(flatSchema: Readonly<Record<string, unknown>>): void {
  let textFields = 0
  for (const [path, type] of Object.entries(flatSchema)) {
    if (typeof type !== 'string') {
      throw new NarsilError(
        ErrorCodes.SCHEMA_INVALID_TYPE,
        `Field "${path}" has an invalid type definition: ${String(type)}`,
        { field: path, type: String(type) },
      )
    }
    if (isWordIndexedBase(parseFieldType(type, path).base)) textFields += 1
  }
  requireTextFieldCount(textFields)
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

const partialFieldsBySchema = new WeakMap<SchemaDefinition, readonly string[]>()

export function partialFieldsOf(schema: SchemaDefinition): readonly string[] {
  const cached = partialFieldsBySchema.get(schema)
  if (cached !== undefined) return cached
  const paths: string[] = []
  for (const field of schemaFieldsOf(schema)) {
    if (field.partial) paths.push(field.path)
  }
  const frozen = Object.freeze(paths.sort(compareCodePoints))
  partialFieldsBySchema.set(schema, frozen)
  return frozen
}

export function extractVectorFieldsFromSchema(schema: SchemaDefinition): Map<string, number> {
  const result = new Map<string, number>()
  for (const field of schemaFieldsOf(schema)) {
    if (field.base === 'vector') result.set(field.path, field.dimension)
  }
  return result
}
