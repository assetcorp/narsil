import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'
import type { EmbeddingFieldConfig, SchemaDefinition } from '../types/schema'
import { flattenSchema } from './validator'

const VECTOR_DIMENSION_PATTERN = /^vector\[(\d+)]$/

export function validateEmbeddingConfig(
  embeddingConfig: EmbeddingFieldConfig,
  schema: SchemaDefinition,
  instanceAdapter: EmbeddingAdapter | undefined,
): EmbeddingAdapter {
  const fieldEntries = Object.keys(embeddingConfig.fields)
  if (fieldEntries.length === 0) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'Embedding config must define at least one field mapping',
    )
  }

  const resolvedAdapter = embeddingConfig.adapter ?? instanceAdapter
  if (!resolvedAdapter) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      'Embedding config requires an adapter (set on the index or the instance)',
    )
  }

  if (
    typeof resolvedAdapter.dimensions !== 'number' ||
    !Number.isInteger(resolvedAdapter.dimensions) ||
    resolvedAdapter.dimensions <= 0
  ) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_CONFIG_INVALID,
      `Adapter dimensions must be a positive integer, got ${resolvedAdapter.dimensions}`,
    )
  }

  const flatFields = flattenSchema(schema)

  for (const [targetField, sourceFields] of Object.entries(embeddingConfig.fields)) {
    const targetType = flatFields[targetField]
    if (targetType === undefined) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        `Embedding target field "${targetField}" does not exist in the schema`,
        { field: targetField },
      )
    }

    const vectorMatch = VECTOR_DIMENSION_PATTERN.exec(targetType)
    if (!vectorMatch) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        `Embedding target field "${targetField}" must be a vector type, got "${targetType}"`,
        { field: targetField, type: targetType },
      )
    }

    const schemaDimension = Number.parseInt(vectorMatch[1], 10)
    if (schemaDimension !== resolvedAdapter.dimensions) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
        `Embedding target field "${targetField}" has dimension ${schemaDimension} but the adapter produces ${resolvedAdapter.dimensions}-dimensional vectors`,
        { field: targetField, expected: schemaDimension, actual: resolvedAdapter.dimensions },
      )
    }

    const sources = Array.isArray(sourceFields) ? sourceFields : [sourceFields]
    if (sources.length === 0) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        `Embedding target field "${targetField}" must have at least one source field`,
        { field: targetField },
      )
    }
    for (const source of sources) {
      const sourceType = flatFields[source]
      if (sourceType === undefined) {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_CONFIG_INVALID,
          `Embedding source field "${source}" does not exist in the schema`,
          { field: source, targetField },
        )
      }
      if (sourceType !== 'string') {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_CONFIG_INVALID,
          `Embedding source field "${source}" must be a string type, got "${sourceType}"`,
          { field: source, type: sourceType, targetField },
        )
      }
    }
  }

  return resolvedAdapter
}

export function validateRequiredFieldsInSchema(required: string[], schema: SchemaDefinition): void {
  if (required.length === 0) return

  const flatFields = flattenSchema(schema)

  for (const field of required) {
    if (flatFields[field] === undefined) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        `Required field "${field}" does not exist in the schema`,
        { field },
      )
    }
  }
}
