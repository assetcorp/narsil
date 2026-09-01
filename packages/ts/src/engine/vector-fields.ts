import { extractVectorFieldsFromSchema } from '../schema/validator'
import type { SchemaDefinition } from '../types/schema'

/**
 * Returns the schema paths that hold vectors.
 *
 * @param schema - The index schema to inspect.
 * @returns Every vector field path.
 */
export function getVectorFieldPaths(schema: SchemaDefinition): Set<string> {
  return new Set(extractVectorFieldsFromSchema(schema).keys())
}
