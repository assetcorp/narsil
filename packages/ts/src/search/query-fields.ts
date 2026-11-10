import { ErrorCodes, NarsilError } from '../errors'
import { flattenSchema } from '../schema/validator'
import { isWordIndexedFieldType } from '../schema/validator/field-type'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { validateBM25Params } from './bm25-params'
import { requireFacetableFields } from './facets'
import { requireGroupableFields } from './grouping-code'

function requireBoostableFields(boost: Record<string, number>, flatSchema: Record<string, string>): void {
  for (const [field, weight] of Object.entries(boost)) {
    const fieldType = flatSchema[field]
    if (fieldType === undefined || !isWordIndexedFieldType(fieldType)) {
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

export function requireUsableQueryFields(params: QueryParams, schema: SchemaDefinition, strict = false): void {
  if (params.bm25 !== undefined) validateBM25Params(params.bm25, schema, ErrorCodes.SEARCH_INVALID_FIELD)
  const groupFields = params.group?.fields
  const checksGroup = Array.isArray(groupFields) && groupFields.length > 0
  if (params.boost === undefined && params.facets === undefined && !checksGroup) return
  const flatSchema = flattenSchema(schema)
  if (params.boost !== undefined) requireBoostableFields(params.boost, flatSchema)
  if (params.facets !== undefined) requireFacetableFields(params.facets, flatSchema, strict)
  if (checksGroup) requireGroupableFields(groupFields, flatSchema, strict)
}
