import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { DocumentStoreReader } from '../document-store'
import { getNestedValue } from '../partition/utils'
import { type StoredValueChange, StoredValueColumn } from './column'

interface StoredFields {
  generation: number
  fields: Map<string, StoredValueColumn>
}

export interface StoredFieldRegions {
  field: string
  values: NativeStoredValues
}

const columns = new WeakMap<DocumentStoreReader, StoredFields>()

export function discardStoredValues(store: DocumentStoreReader): void {
  columns.delete(store)
}

function current(store: DocumentStoreReader): StoredFields | undefined {
  const held = columns.get(store)
  if (held === undefined || held.generation === store.numberingGeneration()) return held
  columns.delete(store)
  return undefined
}

function unchanged(): void {}

export function cachedStoredFields(store: DocumentStoreReader): StoredFieldRegions[] {
  const held = current(store)
  return held === undefined ? [] : Array.from(held.fields, ([field, column]) => ({ field, values: column.regions() }))
}

export function installStoredFields(store: DocumentStoreReader, fields: readonly StoredFieldRegions[]): void {
  if (fields.length === 0) return
  columns.set(store, {
    generation: store.numberingGeneration(),
    fields: new Map(fields.map(({ field, values }) => [field, new StoredValueColumn(values)])),
  })
}

export function storedValuesOf(store: DocumentStoreReader, field: string): NativeStoredValues {
  let held = current(store)
  if (held === undefined) {
    held = { generation: store.numberingGeneration(), fields: new Map() }
    columns.set(store, held)
  }
  let column = held.fields.get(field)
  if (column === undefined) {
    const values = new Array<unknown>(store.internalIdCapacity())
    const read = store.fieldReader(field)
    for (const ordinal of store.allInternalIds()) values[ordinal] = read(ordinal)
    column = new StoredValueColumn(values)
    held.fields.set(field, column)
  }
  return column.regions()
}

export function prepareStoredValues(
  store: DocumentStoreReader,
  removed: number | undefined,
  written: number | undefined,
  document?: Readonly<Record<string, unknown>>,
): () => void {
  const held = current(store)
  if (held === undefined) return unchanged
  const changes: Array<() => void> = []
  for (const [field, column] of held.fields) {
    const values: StoredValueChange[] = []
    if (removed !== undefined && removed !== written) values.push({ ordinal: removed, value: undefined })
    if (written !== undefined)
      values.push({ ordinal: written, value: document === undefined ? undefined : getNestedValue(document, field) })
    changes.push(column.prepare(values))
  }
  return () => {
    for (const apply of changes) apply()
  }
}

export function storedValueBytes(store: DocumentStoreReader): number {
  const held = current(store)
  let bytes = 0
  if (held !== undefined) for (const field of held.fields.values()) bytes += field.bytes()
  return bytes
}
