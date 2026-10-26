import { schemaFieldsOf } from '../../schema/validator/schema'
import type { FilterExpression } from '../../types/filters'
import type { SchemaDefinition } from '../../types/schema'
import { PATTERN_HOST } from './host'
import { availablePatternSearch } from './registry'

export function largestPatternFootprint(
  expression: FilterExpression | undefined,
  schema: SchemaDefinition,
): number | null {
  if (expression === undefined) return null
  const module = availablePatternSearch()
  if (module === null) return null
  const patternFields = new Set<string>()
  for (const { path, pattern } of schemaFieldsOf(schema)) if (pattern) patternFields.add(path)
  return patternFields.size === 0 ? null : module.largestFootprint(expression, patternFields, PATTERN_HOST)
}
