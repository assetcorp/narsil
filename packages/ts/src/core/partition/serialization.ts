import { createGeoIndex } from '../../geo/geo-index'
import type { SerializablePartition } from '../../types/internal'
import type { SchemaDefinition } from '../../types/schema'
import { createBruteForceVectorStore } from '../../vector/brute-force'
import { createBooleanIndex, createEnumIndex, createNumericIndex } from '../field-index'
import type { SerializedPartitionStats } from '../statistics'
import { getFlatSchema, type PartitionState } from './utils'

export function serializePartition(
  state: PartitionState,
  partitionId: number,
  indexName: string,
  totalPartitions: number,
  language: string,
  schema: SchemaDefinition,
): SerializablePartition {
  const flatSchema = getFlatSchema(state, schema)
  const flatSchemaStrings: Record<string, string> = {}
  for (const [k, v] of Object.entries(flatSchema)) {
    flatSchemaStrings[k] = v
  }

  const serializedDocs: SerializablePartition['documents'] = Object.create(null)
  for (const [docId, stored] of state.docStore.all()) {
    serializedDocs[docId] = {
      fields: structuredClone(stored.fields) as Record<string, unknown>,
      fieldLengths: { ...stored.fieldLengths },
    }
  }

  const serializedInverted = state.invertedIdx.serialize()
  const serializedInvertedIndex: SerializablePartition['invertedIndex'] = Object.create(null)
  for (const [token, list] of Object.entries(serializedInverted)) {
    serializedInvertedIndex[token] = {
      docFrequency: list.docFrequency,
      postings: list.postings.map(p => ({
        docId: p.docId,
        termFrequency: p.termFrequency,
        field: p.fieldName,
        positions: [...p.positions],
      })),
    }
  }

  const serializedNumeric: Record<string, Array<{ value: number; docId: string }>> = {}
  for (const [path, idx] of state.numericIndexes) {
    serializedNumeric[path] = idx.serialize()
  }

  const serializedBoolean: Record<string, { trueDocs: string[]; falseDocs: string[] }> = {}
  for (const [path, idx] of state.booleanIndexes) {
    serializedBoolean[path] = idx.serialize()
  }

  const serializedEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    serializedEnum[path] = idx.serialize()
  }

  const serializedGeo: Record<string, Array<{ lat: number; lon: number; docId: string }>> = {}
  for (const [path, idx] of state.geoIndexes) {
    serializedGeo[path] = idx.serialize()
  }

  const serializedVectors: SerializablePartition['vectorData'] = {}
  for (const [path, store] of state.vectorStores) {
    const vectors: Array<{ docId: string; vector: number[] }> = []
    for (const [, entry] of store.entries()) {
      vectors.push({
        docId: entry.docId,
        vector: Array.from(entry.vector),
      })
    }
    serializedVectors[path] = {
      dimension: store.dimension,
      vectors,
      hnswGraph: null,
    }
  }

  const serializedStats = state.stats.serialize()

  return {
    indexName,
    partitionId,
    totalPartitions,
    language,
    schema: flatSchemaStrings,
    docCount: state.docStore.count(),
    avgDocLength: Object.values(serializedStats.averageFieldLengths).reduce((sum, v) => sum + v, 0),
    documents: serializedDocs,
    invertedIndex: serializedInvertedIndex,
    fieldIndexes: {
      numeric: serializedNumeric,
      boolean: serializedBoolean,
      enum: serializedEnum,
      geopoint: serializedGeo,
    },
    vectorData: serializedVectors,
    statistics: serializedStats,
  }
}

export function deserializePartition(
  state: PartitionState,
  data: SerializablePartition,
  clearFn: () => void,
  schema: SchemaDefinition,
): void {
  clearFn()

  const invertedData: Record<
    string,
    {
      docFrequency: number
      postings: Array<{ docId: string; termFrequency: number; fieldName: string; positions: number[] }>
    }
  > = Object.create(null)
  for (const [token, list] of Object.entries(data.invertedIndex)) {
    invertedData[token] = {
      docFrequency: list.docFrequency,
      postings: list.postings.map(p => ({
        docId: p.docId,
        termFrequency: p.termFrequency,
        fieldName: p.field,
        positions: [...p.positions],
      })),
    }
  }
  state.invertedIdx.deserialize(invertedData)

  const docsData: Record<string, { fields: Record<string, unknown>; fieldLengths: Record<string, number> }> =
    Object.create(null)
  for (const [docId, doc] of Object.entries(data.documents)) {
    docsData[docId] = { fields: doc.fields, fieldLengths: doc.fieldLengths }
  }
  state.docStore.deserialize(docsData)

  for (const [path, entries] of Object.entries(data.fieldIndexes.numeric)) {
    const idx = createNumericIndex()
    idx.deserialize(entries)
    state.numericIndexes.set(path, idx)
  }

  for (const [path, serialized] of Object.entries(data.fieldIndexes.boolean)) {
    const idx = createBooleanIndex()
    idx.deserialize(serialized)
    state.booleanIndexes.set(path, idx)
  }

  for (const [path, serialized] of Object.entries(data.fieldIndexes.enum)) {
    const idx = createEnumIndex()
    idx.deserialize(serialized)
    state.enumIndexes.set(path, idx)
  }

  for (const [path, entries] of Object.entries(data.fieldIndexes.geopoint)) {
    const geoIdx = createGeoIndex()
    geoIdx.deserialize(entries)
    state.geoIndexes.set(path, geoIdx)
  }

  for (const [path, vecData] of Object.entries(data.vectorData)) {
    const store = createBruteForceVectorStore(vecData.dimension)
    for (const entry of vecData.vectors) {
      store.insert(entry.docId, new Float32Array(entry.vector))
    }
    state.vectorStores.set(path, store)
  }

  state.stats.deserialize(data.statistics as SerializedPartitionStats)

  const flatSchema = getFlatSchema(state, schema)
  const serializedFields = data.schema
  for (const [field, expectedType] of Object.entries(flatSchema)) {
    if (serializedFields[field] !== (expectedType as string)) {
      throw new Error(
        `Schema mismatch on field "${field}": expected "${expectedType}", found "${serializedFields[field] ?? 'missing'}"`,
      )
    }
  }
  for (const field of Object.keys(serializedFields)) {
    if (!(field in flatSchema)) {
      throw new Error(
        `Schema mismatch: serialized data contains unknown field "${field}" not present in schema`,
      )
    }
  }
}
