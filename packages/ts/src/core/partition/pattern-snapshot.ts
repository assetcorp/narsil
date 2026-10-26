import { schemaFieldsOf } from '../../schema/validator'
import type { SerializedPatternIndex } from '../../types/internal'
import type { SchemaDefinition } from '../../types/schema'
import { patternIndexOf } from '../pattern-index/host'
import { requirePatternSearch } from '../pattern-index/registry'
import { getNestedValue, type PartitionState } from './utils'

export function serializePatternIndexes(
  state: PartitionState,
  schema: SchemaDefinition,
): Record<string, SerializedPatternIndex> | undefined {
  const patternFields = schemaFieldsOf(schema).filter(field => field.pattern)
  if (patternFields.length === 0) return undefined
  const resolver = state.docStore.resolver()
  const toExternal = (ordinal: number): string | undefined => resolver.toExternal(ordinal)
  const serialized: Record<string, SerializedPatternIndex> = Object.create(null)
  for (const { path: fieldPath } of patternFields) {
    const index = state.patternIndexes.get(fieldPath)
    serialized[fieldPath] =
      index === undefined
        ? { docIds: [], runs: {} }
        : requirePatternSearch(fieldPath).serializeIndex(fieldPath, index, toExternal)
  }
  return serialized
}

function rebuildPatternIndex(state: PartitionState, fieldPath: string): void {
  for (const [docId, stored] of state.docStore.all()) {
    const value = getNestedValue(stored.fields as Record<string, unknown>, fieldPath)
    if (value === undefined || value === null) continue
    const internalId = state.docStore.getInternalId(docId)
    if (internalId !== undefined) patternIndexOf(state.patternIndexes, fieldPath).add(internalId, value)
  }
}

export function loadPatternIndexes(
  state: PartitionState,
  serialized: Record<string, SerializedPatternIndex> | undefined,
  schema: SchemaDefinition,
): void {
  const resolver = state.docStore.resolver()
  for (const { path: fieldPath, pattern } of schemaFieldsOf(schema)) {
    if (!pattern) continue
    const entry = serialized !== undefined && Object.hasOwn(serialized, fieldPath) ? serialized[fieldPath] : undefined
    if (entry === undefined) {
      rebuildPatternIndex(state, fieldPath)
      continue
    }
    const decoded = requirePatternSearch(fieldPath).decodeIndex(fieldPath, entry)
    const ordinals = entry.docIds.map(docId => resolver.toInternal(docId) ?? -1)
    patternIndexOf(state.patternIndexes, fieldPath).addArrays(decoded, position => ordinals[position])
  }
}
