import { schemaFieldsOf } from '../../schema/validator'
import type { SchemaDefinition } from '../../types/schema'
import { createNumericIndex, type NumericFieldIndex } from '../field-index'
import { getNestedValue, type PartitionState } from './utils'

export function valueSizeOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return value === '' ? 0 : 1
}

export function sizeIndexOf(indexes: Map<string, NumericFieldIndex>, fieldPath: string): NumericFieldIndex {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = createNumericIndex()
    indexes.set(fieldPath, index)
  }
  return index
}

export function recordValueSize(
  indexes: Map<string, NumericFieldIndex>,
  internalId: number,
  fieldPath: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return
  sizeIndexOf(indexes, fieldPath).insert(internalId, valueSizeOf(value))
}

export function forgetValueSize(
  indexes: Map<string, NumericFieldIndex>,
  internalId: number,
  fieldPath: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return
  indexes.get(fieldPath)?.remove(internalId, valueSizeOf(value))
}

export function rebuildSizeIndexes(state: PartitionState, schema: SchemaDefinition): void {
  state.sizeIndexes.clear()
  const fields = schemaFieldsOf(schema)
  for (const [docId, stored] of state.docStore.all()) {
    const internalId = state.docStore.getInternalId(docId)
    if (internalId === undefined) continue
    for (const { path } of fields) {
      recordValueSize(
        state.sizeIndexes,
        internalId,
        path,
        getNestedValue(stored.fields as Record<string, unknown>, path),
      )
    }
  }
}
