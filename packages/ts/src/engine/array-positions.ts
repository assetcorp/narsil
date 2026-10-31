import { ARRAY_POSITION_GAP } from '../core/constants'
import { ErrorCodes, NarsilError } from '../errors'
import { schemaFieldsOf } from '../schema/validator/schema'
import type { IndexConfig, SchemaDefinition } from '../types/schema'

function holdsStringArrayField(schema: SchemaDefinition): boolean {
  return schemaFieldsOf(schema).some(field => field.base === 'string[]')
}

export function arrayPositionsAreStale(config: IndexConfig, storedGap: number | null): boolean {
  return storedGap !== ARRAY_POSITION_GAP && config.trackPositions !== false && holdsStringArrayField(config.schema)
}

export function storedArrayPositionGap(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

export function requirePhraseReady(
  indexName: string,
  config: IndexConfig,
  isStale: boolean,
  rebuildMode: 'auto' | 'manual',
): void {
  if (!isStale || !holdsStringArrayField(config.schema)) return
  const remedy =
    rebuildMode === 'manual'
      ? 'This engine leaves the rebuild to its caller, so somebody has to start it with rebuildAnalysis'
      : 'Try the query again once the rebuild finishes'
  throw new NarsilError(
    ErrorCodes.SEARCH_PHRASE_NOT_READY,
    `Index "${indexName}" holds array fields whose terms need a rebuild, so it cannot match a phrase yet. ${remedy}`,
    { indexName, rebuild: rebuildMode },
  )
}
