import type { FieldType } from '../../types/schema'
import { ensureFieldIndex } from './indexing'
import { getNestedValue, type PartitionState } from './utils'

function resolveInternalId(state: PartitionState, docId: string): number {
  const internalId = state.docStore.getInternalId(docId)
  if (internalId === undefined) {
    throw new Error(`Internal ID not found for document "${docId}"`)
  }
  return internalId
}

export function updateFieldIndexOnly(
  state: PartitionState,
  docId: string,
  oldFields: Readonly<Record<string, unknown>>,
  newDoc: Record<string, unknown>,
  flatSchema: Record<string, FieldType>,
): void {
  const internalId = resolveInternalId(state, docId)

  for (const [fieldPath, fieldType] of Object.entries(flatSchema)) {
    if (fieldType === 'string' || fieldType === 'string[]') continue

    const oldVal = getNestedValue(oldFields as Record<string, unknown>, fieldPath)
    const newVal = getNestedValue(newDoc, fieldPath)

    if (oldVal === newVal) continue
    if (
      oldVal !== undefined &&
      oldVal !== null &&
      newVal !== undefined &&
      newVal !== null &&
      typeof oldVal === typeof newVal &&
      JSON.stringify(oldVal) === JSON.stringify(newVal)
    )
      continue

    if (newVal !== undefined && newVal !== null) {
      ensureFieldIndex(state, fieldPath, fieldType)
    }

    if (fieldType === 'number') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        if (oldVal !== undefined && oldVal !== null) numIdx.remove(internalId, oldVal as number)
        if (newVal !== undefined && newVal !== null) numIdx.insert(internalId, newVal as number)
      }
    } else if (fieldType === 'boolean') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) boolIdx.remove(internalId, oldVal as boolean)
        if (newVal !== undefined && newVal !== null) boolIdx.insert(internalId, newVal as boolean)
      }
    } else if (fieldType === 'enum') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) enumIdx.remove(internalId, oldVal as string)
        if (newVal !== undefined && newVal !== null) enumIdx.insert(internalId, newVal as string)
      }
    } else if (fieldType === 'geopoint') {
      const geoIdx = state.geoIndexes.get(fieldPath)
      if (geoIdx) {
        if (oldVal !== undefined && oldVal !== null) geoIdx.remove(internalId)
        if (newVal !== undefined && newVal !== null) {
          const geo = newVal as { lat: number; lon: number }
          geoIdx.insert(internalId, geo.lat, geo.lon)
        }
      }
    } else if (fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const n of oldVal as number[]) numIdx.remove(internalId, n)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const n of newVal as number[]) numIdx.insert(internalId, n)
        }
      }
    } else if (fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const b of oldVal as boolean[]) boolIdx.remove(internalId, b)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const b of newVal as boolean[]) boolIdx.insert(internalId, b)
        }
      }
    } else if (fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        if (oldVal !== undefined && oldVal !== null) {
          for (const e of oldVal as string[]) enumIdx.remove(internalId, e)
        }
        if (newVal !== undefined && newVal !== null) {
          for (const e of newVal as string[]) enumIdx.insert(internalId, e)
        }
      }
    }
  }
}
