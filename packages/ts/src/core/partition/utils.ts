import type { GeoIndex } from '../../geo/geo-index'
import { flattenSchema, isTextFieldType } from '../../schema/validator'
import type { FieldNameTable } from '../../types/internal'
import type { CustomTokenizer, FieldType, SchemaDefinition } from '../../types/schema'
import type { DocumentStore, DocumentStoreReader } from '../document-store'
import type { BooleanFieldIndex, EnumFieldIndex, NumericFieldIndex } from '../field-index'
import type { InvertedIndex } from '../inverted-index'
import type { PartitionStats } from '../statistics'
import type { SurfaceRegistry } from '../surface-registry'
import type { PartitionReadState } from './read-state'

export type { PartitionReadState } from './read-state'

export interface PartitionState extends PartitionReadState {
  readonly invertedIdx: InvertedIndex
  readonly docStore: DocumentStore
  readonly stats: PartitionStats
  readonly surfaceRegistry: SurfaceRegistry
  readonly numericIndexes: Map<string, NumericFieldIndex>
  readonly booleanIndexes: Map<string, BooleanFieldIndex>
  readonly enumIndexes: Map<string, EnumFieldIndex>
  readonly geoIndexes: Map<string, GeoIndex>
}

export function getOrCreateFieldNameIndex(table: FieldNameTable, fieldName: string): number {
  const existing = table.indexMap.get(fieldName)
  if (existing !== undefined) return existing
  const idx = table.names.length
  table.names.push(fieldName)
  table.indexMap.set(fieldName, idx)
  return idx
}

export interface PartitionInsertOptions {
  validate?: boolean
  strict?: boolean
  skipClone?: boolean
  stopWordOverride?: Set<string> | ((defaults: Set<string>) => Set<string>)
  customTokenizer?: CustomTokenizer
  collectSurfaces?: boolean
}

const VECTOR_PATTERN = /^vector\[(\d+)]$/

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (let i = 0; i < parts.length; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[parts[i]]
  }
  return current
}

function stringArraysEqual(a: unknown[] | undefined | null, b: unknown[] | undefined | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function textFieldsChanged(
  oldDoc: Readonly<Record<string, unknown>>,
  newDoc: Record<string, unknown>,
  flatSchema: Record<string, FieldType>,
): boolean {
  for (const [path, fieldType] of Object.entries(flatSchema)) {
    if (!isTextFieldType(fieldType) && fieldType !== 'string[]') continue
    const oldVal = getNestedValue(oldDoc as Record<string, unknown>, path)
    const newVal = getNestedValue(newDoc, path)
    if (fieldType !== 'string[]') {
      if (oldVal !== newVal) return true
    } else {
      if (!stringArraysEqual(oldVal as unknown[] | undefined, newVal as unknown[] | undefined)) return true
    }
  }
  return false
}

export function parseVectorDimension(fieldType: string): number | null {
  const match = VECTOR_PATTERN.exec(fieldType)
  return match ? Number.parseInt(match[1], 10) : null
}

export function tokenizeOptions(options?: PartitionInsertOptions) {
  return {
    stem: true,
    removeStopWords: true,
    collectSurfaces: options?.collectSurfaces === true,
    stopWordOverride: options?.stopWordOverride,
    customTokenizer: options?.customTokenizer,
  }
}

export function getFlatSchema(state: PartitionReadState, schema: SchemaDefinition): Record<string, FieldType> {
  if (state.lastSchemaRef === schema && state.flatSchemaCache) return state.flatSchemaCache
  state.flatSchemaCache = flattenSchema(schema)
  state.lastSchemaRef = schema
  return state.flatSchemaCache
}

export function getFieldValueForDoc(docStore: DocumentStoreReader, docId: string, fieldPath: string): unknown {
  const stored = docStore.get(docId)
  if (!stored) return undefined
  return getNestedValue(stored.fields as Record<string, unknown>, fieldPath)
}

export function getFieldValueByInternalId(
  docStore: DocumentStoreReader,
  internalId: number,
  fieldPath: string,
): unknown {
  const externalId = docStore.getExternalId(internalId)
  if (externalId === undefined) return undefined
  return getFieldValueForDoc(docStore, externalId, fieldPath)
}

export function getAllDocIds(docStore: DocumentStoreReader): Set<string> {
  const ids = new Set<string>()
  for (const [id] of docStore.all()) {
    ids.add(id)
  }
  return ids
}

export function getAllInternalDocIds(docStore: DocumentStoreReader): Set<number> {
  const ids = new Set<number>()
  for (const internalId of docStore.allInternalIds()) {
    ids.add(internalId)
  }
  return ids
}
