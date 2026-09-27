import { ErrorCodes, NarsilError } from '../errors'
import { undeclaredFieldOnStrictIndex } from '../filters/operands'
import { flattenSchema } from '../schema/validator'
import { isGeopointOrVectorType, isTextFieldType } from '../schema/validator/shared'
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
        `The boost on field "${field}" must be a finite number, and this query sets ${String(weight)}`,
        { field, boost: String(weight) },
      )
    }
  }
}

function requireFacetableFields(
  facets: Record<string, unknown>,
  flatSchema: Record<string, string>,
  strict: boolean,
): void {
  for (const field of Object.keys(facets)) {
    const fieldType = flatSchema[field]
    if (strict && fieldType === undefined) throw undeclaredFieldOnStrictIndex(field, 'facet')
    if (isGeopointOrVectorType(fieldType)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `The engine counts the values of a text, number, boolean, or enum field, and the schema declares field "${field}" as "${fieldType}"`,
        { field, fieldType },
      )
    }
  }
}

function requireDeclaredGroupFields(fields: readonly string[], flatSchema: Record<string, string>): void {
  for (const field of fields) {
    if (flatSchema[field] === undefined) throw undeclaredFieldOnStrictIndex(field, 'group')
  }
}

export function requireUsableQueryFields(params: QueryParams, schema: SchemaDefinition, strict = false): void {
  const checksGroup = strict && Array.isArray(params.group?.fields)
  if (params.boost === undefined && params.facets === undefined && !checksGroup) return
  const flatSchema = flattenSchema(schema)
  if (params.boost !== undefined) requireBoostableFields(params.boost, flatSchema)
  if (params.facets !== undefined) requireFacetableFields(params.facets, flatSchema, strict)
  if (checksGroup && params.group !== undefined) requireDeclaredGroupFields(params.group.fields, flatSchema)
}
