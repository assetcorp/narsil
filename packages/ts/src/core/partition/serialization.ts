import { createGeoIndex } from '../../geo/geo-index'
import { createVectorSearchEngine } from '../../search/vector-search'
import type { RawPartitionPayload } from '../../serialization/payload-v1'
import type { RawPartitionPayloadV2 } from '../../serialization/payload-v2'
import type { SerializablePartition } from '../../types/internal'
import type { SchemaDefinition } from '../../types/schema'
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
      hnswGraph: store.serializeHNSW(),
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

export function serializePartitionToWirePayload(
  state: PartitionState,
  partitionId: number,
  indexName: string,
  totalPartitions: number,
  language: string,
  schema: SchemaDefinition,
): RawPartitionPayload {
  const flatSchema = getFlatSchema(state, schema)
  const flatSchemaStrings: Record<string, string> = {}
  for (const [k, v] of Object.entries(flatSchema)) {
    flatSchemaStrings[k] = v
  }

  const wireDocs: RawPartitionPayload['documents'] = Object.create(null)
  for (const [docId, stored] of state.docStore.all()) {
    wireDocs[docId] = {
      fields: structuredClone(stored.fields) as Record<string, unknown>,
      field_lengths: { ...stored.fieldLengths },
    }
  }

  const fieldNames = state.fieldNameTable.names
  const wireInverted: RawPartitionPayload['inverted_index'] = Object.create(null)
  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (!list) continue
    const hasDeleted = list.deletedDocs.size > 0
    const postings: Array<{ doc_id: string; term_freq: number; field: string; positions: number[] }> = []
    for (let i = 0; i < list.length; i++) {
      if (hasDeleted && list.deletedDocs.has(list.docIds[i])) continue
      postings.push({
        doc_id: list.docIds[i],
        term_freq: list.termFrequencies[i],
        field: fieldNames[list.fieldNameIndices[i]],
        positions: list.positions ? list.positions[i] : [],
      })
    }
    if (postings.length > 0) {
      wireInverted[token] = { doc_freq: list.docIdSet.size, postings }
    }
  }

  const wireNumeric: RawPartitionPayload['field_indexes']['numeric'] = {}
  for (const [path, idx] of state.numericIndexes) {
    wireNumeric[path] = idx.serialize().map(e => ({ value: e.value, doc_id: e.docId }))
  }

  const wireBoolean: RawPartitionPayload['field_indexes']['boolean'] = {}
  for (const [path, idx] of state.booleanIndexes) {
    const s = idx.serialize()
    wireBoolean[path] = { true_docs: s.trueDocs, false_docs: s.falseDocs }
  }

  const wireEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    wireEnum[path] = idx.serialize()
  }

  const wireGeo: RawPartitionPayload['field_indexes']['geopoint'] = {}
  for (const [path, idx] of state.geoIndexes) {
    wireGeo[path] = idx.serialize().map(e => ({ lat: e.lat, lon: e.lon, doc_id: e.docId }))
  }

  const wireVectors: RawPartitionPayload['vector_data'] = {}
  for (const [path, store] of state.vectorStores) {
    const vectors: Array<{ doc_id: string; vector: number[] }> = []
    for (const [, entry] of store.entries()) {
      vectors.push({ doc_id: entry.docId, vector: Array.from(entry.vector) })
    }
    const hnswData = store.serializeHNSW()
    wireVectors[path] = {
      dimension: store.dimension,
      vectors,
      hnsw_graph: hnswData
        ? {
            entry_point: hnswData.entryPoint,
            max_layer: hnswData.maxLayer,
            m: hnswData.m,
            ef_construction: hnswData.efConstruction,
            metric: hnswData.metric,
            nodes: hnswData.nodes,
          }
        : null,
    }
  }

  const serializedStats = state.stats.serialize()

  return {
    index_name: indexName,
    partition_id: partitionId,
    total_partitions: totalPartitions,
    language,
    schema: flatSchemaStrings,
    doc_count: state.docStore.count(),
    avg_doc_length: Object.values(serializedStats.averageFieldLengths).reduce((sum, v) => sum + v, 0),
    documents: wireDocs,
    inverted_index: wireInverted,
    field_indexes: {
      numeric: wireNumeric,
      boolean: wireBoolean,
      enum: wireEnum,
      geopoint: wireGeo,
    },
    vector_data: wireVectors,
    statistics: {
      total_documents: serializedStats.totalDocuments,
      total_field_lengths: serializedStats.totalFieldLengths,
      average_field_lengths: serializedStats.averageFieldLengths,
      doc_frequencies: serializedStats.docFrequencies,
    },
  }
}

export function serializePartitionToWirePayloadV2(
  state: PartitionState,
  partitionId: number,
  indexName: string,
  totalPartitions: number,
  language: string,
  schema: SchemaDefinition,
): RawPartitionPayloadV2 {
  const flatSchema = getFlatSchema(state, schema)
  const flatSchemaStrings: Record<string, string> = {}
  for (const [k, v] of Object.entries(flatSchema)) {
    flatSchemaStrings[k] = v
  }

  const wireDocs: RawPartitionPayloadV2['documents'] = Object.create(null)
  for (const [docId, stored] of state.docStore.all()) {
    wireDocs[docId] = {
      fields: structuredClone(stored.fields) as Record<string, unknown>,
      field_lengths: { ...stored.fieldLengths },
    }
  }

  const fieldNames = [...state.fieldNameTable.names]
  const wireEntries: Record<string, { df: number; ids: string[]; tf: number[]; fi: number[]; pos: number[][] | null }> =
    Object.create(null)

  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (!list) continue
    const hasDeleted = list.deletedDocs.size > 0

    const ids: string[] = []
    const tf: number[] = []
    const fi: number[] = []
    const pos: number[][] | null = list.positions ? [] : null

    for (let i = 0; i < list.length; i++) {
      if (hasDeleted && list.deletedDocs.has(list.docIds[i])) continue
      ids.push(list.docIds[i])
      tf.push(list.termFrequencies[i])
      fi.push(list.fieldNameIndices[i])
      if (pos && list.positions) {
        pos.push(list.positions[i])
      }
    }

    if (ids.length > 0) {
      wireEntries[token] = { df: list.docIdSet.size, ids, tf, fi, pos }
    }
  }

  const wireNumeric: RawPartitionPayloadV2['field_indexes']['numeric'] = {}
  for (const [path, idx] of state.numericIndexes) {
    wireNumeric[path] = idx.serialize().map(e => ({ value: e.value, doc_id: e.docId }))
  }

  const wireBoolean: RawPartitionPayloadV2['field_indexes']['boolean'] = {}
  for (const [path, idx] of state.booleanIndexes) {
    const s = idx.serialize()
    wireBoolean[path] = { true_docs: s.trueDocs, false_docs: s.falseDocs }
  }

  const wireEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    wireEnum[path] = idx.serialize()
  }

  const wireGeo: RawPartitionPayloadV2['field_indexes']['geopoint'] = {}
  for (const [path, idx] of state.geoIndexes) {
    wireGeo[path] = idx.serialize().map(e => ({ lat: e.lat, lon: e.lon, doc_id: e.docId }))
  }

  const wireVectors: RawPartitionPayloadV2['vector_data'] = {}
  for (const [path, store] of state.vectorStores) {
    const vectors: Array<{ doc_id: string; vector: number[] }> = []
    for (const [, entry] of store.entries()) {
      vectors.push({ doc_id: entry.docId, vector: Array.from(entry.vector) })
    }
    const hnswData = store.serializeHNSW()
    wireVectors[path] = {
      dimension: store.dimension,
      vectors,
      hnsw_graph: hnswData
        ? {
            entry_point: hnswData.entryPoint,
            max_layer: hnswData.maxLayer,
            m: hnswData.m,
            ef_construction: hnswData.efConstruction,
            metric: hnswData.metric,
            nodes: hnswData.nodes,
          }
        : null,
    }
  }

  const serializedStats = state.stats.serialize()

  return {
    v: 2,
    index_name: indexName,
    partition_id: partitionId,
    total_partitions: totalPartitions,
    language,
    schema: flatSchemaStrings,
    doc_count: state.docStore.count(),
    avg_doc_length: Object.values(serializedStats.averageFieldLengths).reduce((sum, v) => sum + v, 0),
    documents: wireDocs,
    inverted_index: {
      field_names: fieldNames,
      entries: wireEntries,
    },
    field_indexes: {
      numeric: wireNumeric,
      boolean: wireBoolean,
      enum: wireEnum,
      geopoint: wireGeo,
    },
    vector_data: wireVectors,
    statistics: {
      total_documents: serializedStats.totalDocuments,
      total_field_lengths: serializedStats.totalFieldLengths,
      average_field_lengths: serializedStats.averageFieldLengths,
      doc_frequencies: serializedStats.docFrequencies,
    },
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
        positions: state.trackPositions ? [...p.positions] : [],
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
    const store = createVectorSearchEngine(vecData.dimension)
    for (const entry of vecData.vectors) {
      store.insert(entry.docId, new Float32Array(entry.vector))
    }
    if (vecData.hnswGraph) {
      store.deserializeHNSW(vecData.hnswGraph)
    }
    state.vectorStores.set(path, store)
  }

  state.stats.deserialize(data.statistics as SerializedPartitionStats)

  const flatSchema = getFlatSchema(state, schema)
  const serializedFields = data.schema
  for (const [field, expectedType] of Object.entries(flatSchema)) {
    if (field in serializedFields && serializedFields[field] !== (expectedType as string)) {
      throw new Error(
        `Schema mismatch on field "${field}": expected "${expectedType}", found "${serializedFields[field]}"`,
      )
    }
  }
  for (const field of Object.keys(serializedFields)) {
    if (!(field in flatSchema)) {
      throw new Error(`Schema mismatch: serialized data contains unknown field "${field}" not present in schema`)
    }
  }
}
