import { createGeoIndex } from '../../geo/geo-index'
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
      fields: stored.fields as Record<string, unknown>,
      fieldLengths: { ...stored.fieldLengths },
    }
  }

  const resolver = state.docStore.resolver()
  const fieldNames = state.fieldNameTable.names
  const serializedInvertedIndex: SerializablePartition['invertedIndex'] = Object.create(null)
  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (!list) continue
    const hasDeleted = list.deletedDocs.size > 0
    const postings: Array<{ docId: string; termFrequency: number; field: string; positions: number[] }> = []
    for (let i = 0; i < list.length; i++) {
      if (hasDeleted && list.deletedDocs.has(list.docIds[i])) continue
      const externalId = resolver.toExternal(list.docIds[i])
      if (externalId === undefined) continue
      postings.push({
        docId: externalId,
        termFrequency: list.termFrequencies[i],
        field: fieldNames[list.fieldNameIndices[i]],
        positions: list.positions ? list.positions[i] : [],
      })
    }
    if (postings.length > 0) {
      serializedInvertedIndex[token] = { docFrequency: list.docIdSet.size, postings }
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
