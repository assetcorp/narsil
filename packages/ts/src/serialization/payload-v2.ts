import { decode, encode } from '@msgpack/msgpack'
import type { SerializablePartition } from '../types/internal'

interface ColumnarPostingList {
  df: number
  ids: string[]
  tf: number[]
  fi: Uint8Array
  pos: number[][] | null
}

export interface RawPartitionPayloadV2 {
  v: 2
  index_name: string
  partition_id: number
  total_partitions: number
  language: string
  schema: Record<string, string>
  doc_count: number
  avg_doc_length: number
  documents: Record<string, { fields: Record<string, unknown>; field_lengths: Record<string, number> }>
  inverted_index: {
    field_names: string[]
    entries: Record<string, ColumnarPostingList>
  }
  field_indexes: {
    numeric: Record<string, Array<{ value: number; doc_id: string }>>
    boolean: Record<string, { true_docs: string[]; false_docs: string[] }>
    enum: Record<string, Record<string, string[]>>
    geopoint: Record<string, Array<{ lat: number; lon: number; doc_id: string }>>
  }
  vector_data?: Record<
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

export function encodeRawPayloadV2(wire: RawPartitionPayloadV2): Uint8Array {
  return encode(wire)
}

const VALID_HNSW_METRICS = new Set(['cosine', 'dotProduct', 'euclidean'])

function validateHnswMetric(value: unknown): 'cosine' | 'dotProduct' | 'euclidean' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && VALID_HNSW_METRICS.has(value)) {
    return value as 'cosine' | 'dotProduct' | 'euclidean'
  }
  return undefined
}

export function deserializePayloadV2(data: Uint8Array): SerializablePartition {
  const raw = decode(data) as RawPartitionPayloadV2

  const documents: SerializablePartition['documents'] = {}
  for (const [docId, doc] of Object.entries(raw.documents ?? {})) {
    documents[docId] = {
      fields: doc.fields,
      fieldLengths: doc.field_lengths ?? {},
    }
  }

  const fieldNames = raw.inverted_index?.field_names ?? []
  const invertedIndex: SerializablePartition['invertedIndex'] = {}
  for (const [token, list] of Object.entries(raw.inverted_index?.entries ?? {})) {
    const count = list.ids.length
    const postings = new Array(count)
    for (let i = 0; i < count; i++) {
      postings[i] = {
        docId: list.ids[i],
        termFrequency: list.tf[i],
        field: fieldNames[list.fi[i]] ?? '',
        positions: list.pos ? list.pos[i] : [],
      }
    }
    invertedIndex[token] = {
      docFrequency: list.df,
      postings,
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

  const vectorData: NonNullable<SerializablePartition['vectorData']> = {}
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
