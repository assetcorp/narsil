import { type BaseFieldType, schemaFieldsOf } from '../../schema/validator'
import type { SchemaDefinition } from '../../types/schema'
import { createNumericIndex, type NumericFieldIndex } from '../field-index'
import { getNestedValue, type PartitionState } from './utils'

export function keepsValueSize(base: BaseFieldType): boolean {
  return base === 'string' || base === 'verbatim' || base.endsWith('[]')
}

export function valueSizeOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return value === '' ? 0 : 1
}

function sizeIndexOf(indexes: Map<string, NumericFieldIndex>, fieldPath: string): NumericFieldIndex {
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
  base: BaseFieldType,
  value: unknown,
): void {
  if (value === undefined || value === null || !keepsValueSize(base)) return
  sizeIndexOf(indexes, fieldPath).insert(internalId, valueSizeOf(value))
}

export function forgetValueSize(
  indexes: Map<string, NumericFieldIndex>,
  internalId: number,
  fieldPath: string,
  base: BaseFieldType,
  value: unknown,
): void {
  if (value === undefined || value === null || !keepsValueSize(base)) return
  indexes.get(fieldPath)?.remove(internalId, valueSizeOf(value))
}

export function rebuildSizeIndexes(state: PartitionState, schema: SchemaDefinition): void {
  state.sizeIndexes.clear()
  const fields = schemaFieldsOf(schema).filter(field => keepsValueSize(field.base))
  if (fields.length === 0) return
  for (const [docId, stored] of state.docStore.all()) {
    const internalId = state.docStore.getInternalId(docId)
    if (internalId === undefined) continue
    for (const { path, base } of fields) {
      const value = getNestedValue(stored.fields as Record<string, unknown>, path)
      recordValueSize(state.sizeIndexes, internalId, path, base, value)
    }
  }
}
