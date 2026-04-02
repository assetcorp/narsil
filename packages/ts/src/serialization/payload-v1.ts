import { decode, encode } from '@msgpack/msgpack'
import type { IndexMetadata, SerializablePartition } from '../types/internal'

export interface RawPartitionPayload {
  index_name: string
  partition_id: number
  total_partitions: number
  language: string
  schema: Record<string, string>
  doc_count: number
  avg_doc_length: number
  documents: Record<string, { fields: Record<string, unknown>; field_lengths: Record<string, number> }>
  inverted_index: Record<
    string,
    {
      doc_freq: number
      postings: Array<{
        doc_id: string
        term_freq: number
        field: string
        positions: number[]
      }>
    }
  >
  field_indexes: {
    numeric: Record<string, Array<{ value: number; doc_id: string }>>
    boolean: Record<string, { true_docs: string[]; false_docs: string[] }>
    enum: Record<string, Record<string, string[]>>
    geopoint: Record<string, Array<{ lat: number; lon: number; doc_id: string }>>
  }
  vector_data: Record<
    string,
    {
      dimension: number
      vectors: Array<{ doc_id: string; vector: number[] }>
      hnsw_graph: null | {
        entry_point: string | null
        max_layer: number
        m: number
        ef_construction: number
        metric?: string
        nodes: Array<[string, number, Array<[number, string[]]>]>
      }
      sq8?: {
        alpha: number
        offset: number
        quantized_vectors: Record<string, number[]>
        vector_sums: Record<string, number>
        vector_sum_sqs: Record<string, number>
      } | null
    }
  >
  statistics: {
    total_documents: number
    total_field_lengths: Record<string, number>
    average_field_lengths: Record<string, number>
    doc_frequencies: Record<string, number>
  }
}

interface RawMetadataPayload {
  index_name: string
  schema: Record<string, string>
  language: string
  partition_count: number
  bm25_params: { k1: number; b: number }
  created_at: number
  engine_version: string
}

function partitionToWire(partition: SerializablePartition): RawPartitionPayload {
  const wireDocuments: RawPartitionPayload['documents'] = {}
  for (const [docId, doc] of Object.entries(partition.documents)) {
    wireDocuments[docId] = {
      fields: doc.fields,
      field_lengths: doc.fieldLengths,
    }
  }

  const wireIndex: RawPartitionPayload['inverted_index'] = {}
  for (const [token, list] of Object.entries(partition.invertedIndex)) {
    wireIndex[token] = {
      doc_freq: list.docFrequency,
      postings: list.postings.map(p => ({
        doc_id: p.docId,
        term_freq: p.termFrequency,
        field: p.field,
        positions: p.positions,
      })),
    }
  }

  const wireNumeric: RawPartitionPayload['field_indexes']['numeric'] = {}
  for (const [field, entries] of Object.entries(partition.fieldIndexes.numeric)) {
    wireNumeric[field] = entries.map(e => ({ value: e.value, doc_id: e.docId }))
  }

  const wireBoolean: RawPartitionPayload['field_indexes']['boolean'] = {}
  for (const [field, idx] of Object.entries(partition.fieldIndexes.boolean)) {
    wireBoolean[field] = { true_docs: idx.trueDocs, false_docs: idx.falseDocs }
  }

  const wireGeopoint: RawPartitionPayload['field_indexes']['geopoint'] = {}
  for (const [field, entries] of Object.entries(partition.fieldIndexes.geopoint)) {
    wireGeopoint[field] = entries.map(e => ({ lat: e.lat, lon: e.lon, doc_id: e.docId }))
  }

  const wireVectors: RawPartitionPayload['vector_data'] = {}
  for (const [field, data] of Object.entries(partition.vectorData)) {
    wireVectors[field] = {
      dimension: data.dimension,
      vectors: data.vectors.map(v => ({ doc_id: v.docId, vector: v.vector })),
      hnsw_graph: data.hnswGraph
        ? {
            entry_point: data.hnswGraph.entryPoint,
            max_layer: data.hnswGraph.maxLayer,
            m: data.hnswGraph.m,
            ef_construction: data.hnswGraph.efConstruction,
            metric: data.hnswGraph.metric,
            nodes: data.hnswGraph.nodes,
          }
        : null,
      sq8: data.sq8
        ? {
            alpha: data.sq8.alpha,
            offset: data.sq8.offset,
            quantized_vectors: data.sq8.quantizedVectors,
            vector_sums: data.sq8.vectorSums,
            vector_sum_sqs: data.sq8.vectorSumSqs,
          }
        : null,
    }
  }

  return {
    index_name: partition.indexName,
    partition_id: partition.partitionId,
    total_partitions: partition.totalPartitions,
    language: partition.language,
    schema: partition.schema,
    doc_count: partition.docCount,
    avg_doc_length: partition.avgDocLength,
    documents: wireDocuments,
    inverted_index: wireIndex,
    field_indexes: {
      numeric: wireNumeric,
      boolean: wireBoolean,
      enum: partition.fieldIndexes.enum,
      geopoint: wireGeopoint,
    },
    vector_data: wireVectors,
    statistics: {
      total_documents: partition.statistics.totalDocuments,
      total_field_lengths: partition.statistics.totalFieldLengths,
      average_field_lengths: partition.statistics.averageFieldLengths,
      doc_frequencies: partition.statistics.docFrequencies,
    },
  }
}

const VALID_HNSW_METRICS = new Set(['cosine', 'dotProduct', 'euclidean'])

function validateHnswMetric(value: unknown): 'cosine' | 'dotProduct' | 'euclidean' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && VALID_HNSW_METRICS.has(value)) {
    return value as 'cosine' | 'dotProduct' | 'euclidean'
  }
  return undefined
}

function wireToPartition(raw: RawPartitionPayload): SerializablePartition {
  const documents: SerializablePartition['documents'] = {}
  for (const [docId, doc] of Object.entries(raw.documents ?? {})) {
    documents[docId] = {
      fields: doc.fields,
      fieldLengths: doc.field_lengths ?? {},
    }
  }

  const invertedIndex: SerializablePartition['invertedIndex'] = {}
  for (const [token, list] of Object.entries(raw.inverted_index ?? {})) {
    invertedIndex[token] = {
      docFrequency: list.doc_freq,
      postings: (list.postings ?? []).map(p => ({
        docId: p.doc_id,
        termFrequency: p.term_freq,
        field: p.field,
        positions: p.positions ?? [],
      })),
    }
  }

  const numeric: SerializablePartition['fieldIndexes']['numeric'] = {}
  for (const [field, entries] of Object.entries(raw.field_indexes?.numeric ?? {})) {
    numeric[field] = entries.map(e => ({ value: e.value, docId: e.doc_id }))
  }

  const boolean: SerializablePartition['fieldIndexes']['boolean'] = {}
  for (const [field, idx] of Object.entries(raw.field_indexes?.boolean ?? {})) {
    boolean[field] = { trueDocs: idx.true_docs ?? [], falseDocs: idx.false_docs ?? [] }
  }

  const geopoint: SerializablePartition['fieldIndexes']['geopoint'] = {}
  for (const [field, entries] of Object.entries(raw.field_indexes?.geopoint ?? {})) {
    geopoint[field] = entries.map(e => ({ lat: e.lat, lon: e.lon, docId: e.doc_id }))
  }

  const vectorData: SerializablePartition['vectorData'] = {}
  for (const [field, data] of Object.entries(raw.vector_data ?? {})) {
    vectorData[field] = {
      dimension: data.dimension,
      vectors: (data.vectors ?? []).map(v => ({ docId: v.doc_id, vector: v.vector })),
      hnswGraph: data.hnsw_graph
        ? {
            entryPoint: data.hnsw_graph.entry_point,
            maxLayer: data.hnsw_graph.max_layer,
            m: data.hnsw_graph.m,
            efConstruction: data.hnsw_graph.ef_construction,
            metric: validateHnswMetric(data.hnsw_graph.metric),
            nodes: data.hnsw_graph.nodes,
          }
        : null,
      sq8: data.sq8
        ? {
            alpha: data.sq8.alpha,
            offset: data.sq8.offset,
            quantizedVectors: data.sq8.quantized_vectors,
            vectorSums: data.sq8.vector_sums,
            vectorSumSqs: data.sq8.vector_sum_sqs,
          }
        : null,
    }
  }

  return {
    indexName: raw.index_name,
    partitionId: raw.partition_id,
    totalPartitions: raw.total_partitions,
    language: raw.language ?? 'english',
    schema: raw.schema ?? {},
    docCount: raw.doc_count ?? 0,
    avgDocLength: raw.avg_doc_length ?? 0,
    documents,
    invertedIndex,
    fieldIndexes: {
      numeric,
      boolean,
      enum: raw.field_indexes?.enum ?? {},
      geopoint,
    },
    vectorData,
    statistics: {
      totalDocuments: raw.statistics?.total_documents ?? 0,
      totalFieldLengths: raw.statistics?.total_field_lengths ?? {},
      averageFieldLengths: raw.statistics?.average_field_lengths ?? {},
      docFrequencies: raw.statistics?.doc_frequencies ?? {},
    },
  }
}

export function serializePayloadV1(partition: SerializablePartition): Uint8Array {
  const wire = partitionToWire(partition)
  return encode(wire)
}

export function encodeRawPayload(wire: RawPartitionPayload): Uint8Array {
  return encode(wire)
}

export function deserializePayloadV1(data: Uint8Array): SerializablePartition {
  const raw = decode(data) as RawPartitionPayload
  return wireToPartition(raw)
}

function metadataToWire(meta: IndexMetadata): RawMetadataPayload {
  return {
    index_name: meta.indexName,
    schema: meta.schema,
    language: meta.language,
    partition_count: meta.partitionCount,
    bm25_params: meta.bm25Params,
    created_at: meta.createdAt,
    engine_version: meta.engineVersion,
  }
}

function wireToMetadata(raw: RawMetadataPayload): IndexMetadata {
  return {
    indexName: raw.index_name,
    schema: raw.schema ?? {},
    language: raw.language ?? 'english',
    partitionCount: raw.partition_count ?? 1,
    bm25Params: raw.bm25_params ?? { k1: 1.2, b: 0.75 },
    createdAt: raw.created_at ?? 0,
    engineVersion: raw.engine_version ?? '0.0.0',
  }
}

export function serializeMetadata(meta: IndexMetadata): Uint8Array {
  const wire = metadataToWire(meta)
  return encode(wire)
}

export function deserializeMetadata(data: Uint8Array): IndexMetadata {
  const raw = decode(data) as RawMetadataPayload
  return wireToMetadata(raw)
}
