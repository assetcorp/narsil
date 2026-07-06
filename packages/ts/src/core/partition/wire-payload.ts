import type { RawPartitionPayload } from '../../serialization/payload-v1'
import type { RawPartitionPayloadV2 } from '../../serialization/payload-v2'
import type { SchemaDefinition } from '../../types/schema'
import { getFlatSchema, type PartitionState } from './utils'

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
      fields: stored.fields as Record<string, unknown>,
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
    surface_forms: state.surfaceRegistry.serialize(),
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
      fields: stored.fields as Record<string, unknown>,
      field_lengths: { ...stored.fieldLengths },
    }
  }

  const resolver = state.docStore.resolver()
  const fieldNames = [...state.fieldNameTable.names]
  const wireEntries: Record<
    string,
    { df: number; ids: string[]; tf: number[]; fi: Uint8Array; pos: number[][] | null }
  > = Object.create(null)

  for (const token of state.invertedIdx.tokens()) {
    const list = state.invertedIdx.lookup(token)
    if (!list) continue
    const hasDeleted = list.deletedDocs.size > 0

    const ids: string[] = []
    const tf: number[] = []
    const fi = new Uint8Array(list.length)
    const pos: number[][] | null = list.positions ? [] : null
    let writeIdx = 0

    for (let i = 0; i < list.length; i++) {
      if (hasDeleted && list.deletedDocs.has(list.docIds[i])) continue
      const externalId = resolver.toExternal(list.docIds[i])
      if (externalId === undefined) continue
      ids.push(externalId)
      tf.push(list.termFrequencies[i])
      fi[writeIdx] = list.fieldNameIndices[i]
      writeIdx++
      if (pos && list.positions) {
        pos.push(list.positions[i])
      }
    }

    if (ids.length > 0) {
      const finalFi = writeIdx < list.length ? fi.subarray(0, writeIdx) : fi
      wireEntries[token] = { df: list.docIdSet.size, ids, tf, fi: finalFi, pos }
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
    surface_forms: state.surfaceRegistry.serialize(),
    statistics: {
      total_documents: serializedStats.totalDocuments,
      total_field_lengths: serializedStats.totalFieldLengths,
      average_field_lengths: serializedStats.averageFieldLengths,
      doc_frequencies: serializedStats.docFrequencies,
    },
  }
}
