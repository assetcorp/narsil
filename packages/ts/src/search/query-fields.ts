import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema } from '../schema/validator'
import { isTextFieldType, VECTOR_PATTERN } from '../schema/validator/shared'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'

function requireBoostableFields(boost: Record<string, number>, flatSchema: Record<string, string>): void {
  for (const [field, weight] of Object.entries(boost)) {
    const fieldType = flatSchema[field]
    if (fieldType === undefined || (!isTextFieldType(fieldType) && fieldType !== 'string[]')) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        fieldType === undefined
          ? `The engine boosts a text field that the schema declares, and the schema declares no field "${field}"`
          : `The engine boosts a text field alone, and the schema declares field "${field}" as "${fieldType}"`,
        { field, ...(fieldType === undefined ? {} : { fieldType }) },
      )
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `The engine takes the boost on field "${field}" as a finite number, and this query sets ${String(weight)}`,
        { field, boost: String(weight) },
      )
    }
  }
}

function requireFacetableFields(facets: Record<string, unknown>, flatSchema: Record<string, string>): void {
  for (const field of Object.keys(facets)) {
    const fieldType = flatSchema[field]
    if (fieldType === 'geopoint' || (fieldType !== undefined && VECTOR_PATTERN.test(fieldType))) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine counts the values of a text, number, boolean, or enum field, and the schema declares field "${field}" as "${fieldType}"`,
        { field, fieldType },
      )
    }
  }
}

export function requireUsableQueryFields(params: QueryParams, schema: SchemaDefinition): void {
  if (params.boost === undefined && params.facets === undefined) return
  const flatSchema = flattenSchema(schema)
  if (params.boost !== undefined) requireBoostableFields(params.boost, flatSchema)
  if (params.facets !== undefined) requireFacetableFields(params.facets, flatSchema)
}
