import type { GeoIndex } from '../../geo/geo-index'
import { flattenSchema } from '../../schema/validator'
import type { VectorSearchEngine } from '../../search/vector-search'
import type { FieldNameTable } from '../../types/internal'
import type { CustomTokenizer, FieldType, SchemaDefinition, VectorIndexConfig } from '../../types/schema'
import type { DocumentStore } from '../document-store'
import type { BooleanFieldIndex, EnumFieldIndex, NumericFieldIndex } from '../field-index'
import type { InvertedIndex } from '../inverted-index'
import type { PartitionStats } from '../statistics'

export interface PartitionState {
  invertedIdx: InvertedIndex
  docStore: DocumentStore
  stats: PartitionStats
  numericIndexes: Map<string, NumericFieldIndex>
  booleanIndexes: Map<string, BooleanFieldIndex>
  enumIndexes: Map<string, EnumFieldIndex>
  geoIndexes: Map<string, GeoIndex>
  vectorStores: Map<string, VectorSearchEngine>
  vectorIndexConfig: VectorIndexConfig | null
  fieldNameTable: FieldNameTable
  flatSchemaCache: Record<string, FieldType> | null
  lastSchemaRef: SchemaDefinition | null
  trackPositions: boolean
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
    if (fieldType !== 'string' && fieldType !== 'string[]') continue
    const oldVal = getNestedValue(oldDoc as Record<string, unknown>, path)
    const newVal = getNestedValue(newDoc, path)
    if (fieldType === 'string') {
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
    stopWordOverride: options?.stopWordOverride,
    customTokenizer: options?.customTokenizer,
  }
}

export function getFlatSchema(state: PartitionState, schema: SchemaDefinition): Record<string, FieldType> {
  if (state.lastSchemaRef === schema && state.flatSchemaCache) return state.flatSchemaCache
  state.flatSchemaCache = flattenSchema(schema)
  state.lastSchemaRef = schema
  return state.flatSchemaCache
}

export function getFieldValueForDoc(docStore: DocumentStore, docId: string, fieldPath: string): unknown {
  const stored = docStore.get(docId)
  if (!stored) return undefined
  return getNestedValue(stored.fields as Record<string, unknown>, fieldPath)
}

export function getAllDocIds(docStore: DocumentStore): Set<string> {
  const ids = new Set<string>()
  for (const [id] of docStore.all()) {
    ids.add(id)
  }
  return ids
}
