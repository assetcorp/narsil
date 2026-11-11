import type { AnyDocument } from '../../types/schema'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { PartitionIndex } from '../partition'
import { getNestedValue } from '../partition/utils'
import { buildStoredValues } from './build'
import { storedValuesOf } from './columns'

export interface StoredFieldReference {
  values: NativeStoredValues
  ordinal: number
}

const documents = new WeakMap<AnyDocument, Map<string, NativeStoredValues>>()

export function documentStoredFields(
  document: AnyDocument | undefined,
  fields: readonly string[],
): StoredFieldReference[] | undefined {
  if (document === undefined) return undefined
  let held = documents.get(document)
  if (held === undefined) {
    held = new Map()
    documents.set(document, held)
  }
  return fields.map(field => {
    let values = held.get(field)
    if (values === undefined) {
      values = buildStoredValues([getNestedValue(document, field)])
      held.set(field, values)
    }
    return { values, ordinal: 0 }
  })
}

export function partitionStoredFields(
  partition: PartitionIndex | undefined,
  docId: string,
  fields: readonly string[],
): StoredFieldReference[] | undefined {
  if (partition === undefined) return undefined
  for (const state of partition.readStates()) {
    const ordinal = state.docStore.getInternalId(docId)
    if (ordinal !== undefined) return fields.map(field => ({ values: storedValuesOf(state.docStore, field), ordinal }))
  }
  return undefined
}
