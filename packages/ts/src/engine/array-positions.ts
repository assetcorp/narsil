import { ARRAY_POSITION_GAP } from '../core/constants'
import { schemaFieldsOf } from '../schema/validator/schema'
import type { IndexConfig, SchemaDefinition } from '../types/schema'

export function holdsStringArrayField(schema: SchemaDefinition): boolean {
  return schemaFieldsOf(schema).some(field => field.base === 'string[]')
}

export function arrayPositionsAreStale(config: IndexConfig, storedGap: number | null): boolean {
  return storedGap !== ARRAY_POSITION_GAP && config.trackPositions !== false && holdsStringArrayField(config.schema)
}

export function storedArrayPositionGap(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}
