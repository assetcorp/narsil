import { flattenSchema } from '../schema/validator'
import type { FilterExpression } from '../types/filters'
import type { SchemaDefinition } from '../types/schema'
import { validatedFilterOf } from './operands'

export function validQueryFilter(
  filters: FilterExpression | undefined,
  schema: SchemaDefinition,
): FilterExpression | undefined {
  if (filters === undefined || filters === null) return filters
  return validatedFilterOf(filters, flattenSchema(schema))
}
