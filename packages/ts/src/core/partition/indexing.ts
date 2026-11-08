import { createLoadedGeoIndex } from '../../geo/geo-code'
import type { BaseFieldType, SchemaField } from '../../schema/validator'
import { createBooleanIndex, createEnumIndex, createNumericIndex } from '../field-index'
import { patternIndexOf } from '../pattern-index/host'
import { keywordFields } from './keyword-writes'
import type { PreparedText } from './prepared-text'
import { SegmentFull } from './segment-full'
import { getNestedValue, type PartitionState } from './utils'
import { forgetValueSize, recordValueSize } from './value-sizes'

export function ensureFieldIndex(state: PartitionState, fieldPath: string, base: BaseFieldType): void {
  if ((base === 'number' || base === 'number[]') && !state.numericIndexes.has(fieldPath)) {
    state.numericIndexes.set(fieldPath, createNumericIndex())
  } else if ((base === 'boolean' || base === 'boolean[]') && !state.booleanIndexes.has(fieldPath)) {
    state.booleanIndexes.set(fieldPath, createBooleanIndex())
  } else if ((base === 'enum' || base === 'enum[]') && !state.enumIndexes.has(fieldPath)) {
    state.enumIndexes.set(fieldPath, createEnumIndex())
  } else if (base === 'geopoint' && !state.geoIndexes.has(fieldPath)) {
    state.geoIndexes.set(fieldPath, createLoadedGeoIndex())
  }
}

export function indexDocument(
  state: PartitionState,
  internalId: number,
  document: Record<string, unknown>,
  fields: readonly SchemaField[],
  prepared: PreparedText,
): void {
  const keyword = keywordFields(state, prepared, fields, internalId)
  if (!keyword.segment.insert(internalId, keyword.fields, prepared.tokens)) throw new SegmentFull({ after: prepared })
  for (const { path: fieldPath, base, pattern } of fields) {
    const value = getNestedValue(document, fieldPath)
    if (value === undefined || value === null) continue
    recordValueSize(state.sizeIndexes, internalId, fieldPath, base, value)
    ensureFieldIndex(state, fieldPath, base)
    if (pattern) patternIndexOf(state.patternIndexes, fieldPath).add(internalId, value)

    if (base === 'number') {
      state.numericIndexes.get(fieldPath)?.insert(internalId, value as number)
    } else if (base === 'boolean') {
      state.booleanIndexes.get(fieldPath)?.insert(internalId, value as boolean)
    } else if (base === 'enum') {
      state.enumIndexes.get(fieldPath)?.insert(internalId, value as string)
    } else if (base === 'geopoint') {
      const geo = value as { lat: number; lon: number }
      state.geoIndexes.get(fieldPath)?.insert(internalId, geo.lat, geo.lon)
    } else if (base === 'number[]') {
      const index = state.numericIndexes.get(fieldPath)
      for (const number of value as number[]) index?.insert(internalId, number)
    } else if (base === 'boolean[]') {
      const index = state.booleanIndexes.get(fieldPath)
      for (const boolean of value as boolean[]) index?.insert(internalId, boolean)
    } else if (base === 'enum[]') {
      const index = state.enumIndexes.get(fieldPath)
      for (const entry of value as string[]) index?.insert(internalId, entry)
    }
  }
}

export function removeFromIndexes(
  state: PartitionState,
  internalId: number,
  document: Readonly<Record<string, unknown>>,
  schemaFields: readonly SchemaField[],
  prepared: PreparedText,
): void {
  const keyword = keywordFields(state, prepared, schemaFields, internalId)
  keyword.segment.remove(internalId, keyword.fields, prepared.tokens)
  for (const { path: fieldPath, base, pattern } of schemaFields) {
    const value = getNestedValue(document, fieldPath)
    if (value === undefined || value === null) continue
    forgetValueSize(state.sizeIndexes, internalId, fieldPath, base, value)
    if (pattern) state.patternIndexes.get(fieldPath)?.remove(internalId, value)

    if (base === 'number') {
      state.numericIndexes.get(fieldPath)?.remove(internalId, value as number)
    } else if (base === 'boolean') {
      state.booleanIndexes.get(fieldPath)?.remove(internalId, value as boolean)
    } else if (base === 'enum') {
      state.enumIndexes.get(fieldPath)?.remove(internalId, value as string)
    } else if (base === 'geopoint') {
      state.geoIndexes.get(fieldPath)?.remove(internalId)
    } else if (base === 'number[]') {
      const index = state.numericIndexes.get(fieldPath)
      for (const number of value as number[]) index?.remove(internalId, number)
    } else if (base === 'boolean[]') {
      const index = state.booleanIndexes.get(fieldPath)
      for (const boolean of value as boolean[]) index?.remove(internalId, boolean)
    } else if (base === 'enum[]') {
      const index = state.enumIndexes.get(fieldPath)
      for (const entry of value as string[]) index?.remove(internalId, entry)
    }
  }
}
