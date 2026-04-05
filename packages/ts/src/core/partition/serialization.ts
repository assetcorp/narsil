import { createGeoIndex } from '../../geo/geo-index'
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

  const resolver = state.docStore.resolver()
  const serializedInverted = state.invertedIdx.serialize(resolver)
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
    const raw = idx.serialize()
    serializedNumeric[path] = raw.map(e => {
      const externalId = resolver.toExternal(e.docId)
      return { value: e.value, docId: externalId ?? '' }
    })
  }

  const serializedBoolean: Record<string, { trueDocs: string[]; falseDocs: string[] }> = {}
  for (const [path, idx] of state.booleanIndexes) {
    const raw = idx.serialize()
    serializedBoolean[path] = {
      trueDocs: raw.trueDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
      falseDocs: raw.falseDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
    }
  }

  const serializedEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    const raw = idx.serialize()
    const converted: Record<string, string[]> = Object.create(null)
    for (const [value, internalIds] of Object.entries(raw)) {
      converted[value] = internalIds.map(id => resolver.toExternal(id) ?? '').filter(id => id !== '')
    }
    serializedEnum[path] = converted
  }

  const serializedGeo: Record<string, Array<{ lat: number; lon: number; docId: string }>> = {}
  for (const [path, idx] of state.geoIndexes) {
    const raw = idx.serialize()
    serializedGeo[path] = raw.map(e => ({
      lat: e.lat,
      lon: e.lon,
      docId: resolver.toExternal(e.docId) ?? '',
    }))
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

  const resolver = state.docStore.resolver()
  const fieldNames = state.fieldNameTable.names
  const wireInverted: RawPartitionPayload['inverted_index'] = Object.create(null)
  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (!list) continue
    const hasDeleted = list.deletedDocs.size > 0
    const postings: Array<{ doc_id: string; term_freq: number; field: string; positions: number[] }> = []
    for (let i = 0; i < list.length; i++) {
      if (hasDeleted && list.deletedDocs.has(list.docIds[i])) continue
      const externalId = resolver.toExternal(list.docIds[i])
      if (externalId === undefined) continue
      postings.push({
        doc_id: externalId,
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
    wireNumeric[path] = idx.serialize().map(e => ({
      value: e.value,
      doc_id: resolver.toExternal(e.docId) ?? '',
    }))
  }

  const wireBoolean: RawPartitionPayload['field_indexes']['boolean'] = {}
  for (const [path, idx] of state.booleanIndexes) {
    const s = idx.serialize()
    wireBoolean[path] = {
      true_docs: s.trueDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
      false_docs: s.falseDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
    }
  }

  const wireEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    const raw = idx.serialize()
    const converted: Record<string, string[]> = Object.create(null)
    for (const [value, internalIds] of Object.entries(raw)) {
      converted[value] = internalIds.map(id => resolver.toExternal(id) ?? '').filter(id => id !== '')
    }
    wireEnum[path] = converted
  }

  const wireGeo: RawPartitionPayload['field_indexes']['geopoint'] = {}
  for (const [path, idx] of state.geoIndexes) {
    wireGeo[path] = idx.serialize().map(e => ({
      lat: e.lat,
      lon: e.lon,
      doc_id: resolver.toExternal(e.docId) ?? '',
    }))
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

  const resolver = state.docStore.resolver()
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
      const externalId = resolver.toExternal(list.docIds[i])
      if (externalId === undefined) continue
      ids.push(externalId)
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
    wireNumeric[path] = idx.serialize().map(e => ({
      value: e.value,
      doc_id: resolver.toExternal(e.docId) ?? '',
    }))
  }

  const wireBoolean: RawPartitionPayloadV2['field_indexes']['boolean'] = {}
  for (const [path, idx] of state.booleanIndexes) {
    const s = idx.serialize()
    wireBoolean[path] = {
      true_docs: s.trueDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
      false_docs: s.falseDocs.map(id => resolver.toExternal(id) ?? '').filter(id => id !== ''),
    }
  }

  const wireEnum: Record<string, Record<string, string[]>> = {}
  for (const [path, idx] of state.enumIndexes) {
    const raw = idx.serialize()
    const converted: Record<string, string[]> = Object.create(null)
    for (const [value, internalIds] of Object.entries(raw)) {
      converted[value] = internalIds.map(id => resolver.toExternal(id) ?? '').filter(id => id !== '')
    }
    wireEnum[path] = converted
  }

  const wireGeo: RawPartitionPayloadV2['field_indexes']['geopoint'] = {}
  for (const [path, idx] of state.geoIndexes) {
    wireGeo[path] = idx.serialize().map(e => ({
      lat: e.lat,
      lon: e.lon,
      doc_id: resolver.toExternal(e.docId) ?? '',
    }))
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

  const docsData: Record<string, { fields: Record<string, unknown>; fieldLengths: Record<string, number> }> =
    Object.create(null)
  for (const [docId, doc] of Object.entries(data.documents)) {
    docsData[docId] = { fields: doc.fields, fieldLengths: doc.fieldLengths }
  }
  state.docStore.deserialize(docsData)

  const resolver = state.docStore.resolver()

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
  state.invertedIdx.deserialize(invertedData, resolver)

  for (const [path, entries] of Object.entries(data.fieldIndexes.numeric)) {
    const idx = createNumericIndex()
    const converted = entries
      .map(e => {
        const internalId = resolver.toInternal(e.docId)
        return { value: e.value, docId: internalId ?? -1 }
      })
      .filter(e => e.docId !== -1)
    idx.deserialize(converted)
    state.numericIndexes.set(path, idx)
  }

  for (const [path, serialized] of Object.entries(data.fieldIndexes.boolean)) {
    const idx = createBooleanIndex()
    const trueDocs = serialized.trueDocs
      .map(id => resolver.toInternal(id))
      .filter((id): id is number => id !== undefined)
    const falseDocs = serialized.falseDocs
      .map(id => resolver.toInternal(id))
      .filter((id): id is number => id !== undefined)
    idx.deserialize({ trueDocs, falseDocs })
    state.booleanIndexes.set(path, idx)
  }

  for (const [path, serialized] of Object.entries(data.fieldIndexes.enum)) {
    const idx = createEnumIndex()
    const converted: Record<string, number[]> = Object.create(null)
    for (const [value, docIds] of Object.entries(serialized)) {
      converted[value] = docIds.map(id => resolver.toInternal(id)).filter((id): id is number => id !== undefined)
    }
    idx.deserialize(converted)
    state.enumIndexes.set(path, idx)
  }

  for (const [path, entries] of Object.entries(data.fieldIndexes.geopoint)) {
    const geoIdx = createGeoIndex()
    const converted = entries
      .map(e => ({
        lat: e.lat,
        lon: e.lon,
        docId: resolver.toInternal(e.docId) ?? -1,
      }))
      .filter(e => e.docId !== -1)
    geoIdx.deserialize(converted)
    state.geoIndexes.set(path, geoIdx)
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
