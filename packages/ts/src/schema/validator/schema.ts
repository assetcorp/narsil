import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import {
  FIELD_NAME_PATTERN,
  isPlainObject,
  MAX_NESTING_DEPTH,
  PROTOTYPE_POLLUTION_KEYS,
  RESERVED_ROOT_FIELDS,
  SCALAR_FIELD_TYPES,
  VECTOR_PATTERN,
} from './shared'

function validateSchemaFields(schema: SchemaDefinition, depth: number, prefix: string): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_DEPTH_EXCEEDED,
      `Schema nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH} at "${prefix}"`,
      { path: prefix, maxDepth: MAX_NESTING_DEPTH },
    )
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
      validateSchemaFields(type as SchemaDefinition, depth + 1, path)
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

    if (SCALAR_FIELD_TYPES.has(type)) continue

    const vectorMatch = VECTOR_PATTERN.exec(type)
    if (vectorMatch) {
      const dimension = Number.parseInt(vectorMatch[1], 10)
      if (dimension <= 0) {
        throw new NarsilError(
          ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
          `Vector field "${path}" must have a positive dimension, got ${dimension}`,
          { field: path, dimension },
        )
      }
      continue
    }

    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, `Field "${path}" has an unsupported type: "${type}"`, {
      field: path,
      type,
    })
  }
}

export function validateSchema(schema: SchemaDefinition): void {
  if (!isPlainObject(schema)) {
    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Schema must be a plain object', {
      received: typeof schema,
    })
  }

  if (Object.keys(schema).length === 0) {
    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Schema must define at least one field')
  }

  validateSchemaFields(schema, 1, '')
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

export function flattenSchema(schema: SchemaDefinition): Record<string, FieldType> {
  const result: Record<string, FieldType> = {}
  flattenRecursive(schema, '', result)
  return result
}

export function extractVectorFieldsFromSchema(schema: SchemaDefinition): Map<string, number> {
  const flat = flattenSchema(schema)
  const result = new Map<string, number>()
  for (const [fieldPath, fieldType] of Object.entries(flat)) {
    const match = VECTOR_PATTERN.exec(fieldType)
    if (match) {
      result.set(fieldPath, Number.parseInt(match[1], 10))
    }
  }
  return result
}
