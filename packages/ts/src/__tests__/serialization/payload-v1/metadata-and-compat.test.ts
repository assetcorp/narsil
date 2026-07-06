import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import {
  deserializeMetadata,
  deserializePayloadV1,
  encodeRawPayload,
  type RawPartitionPayload,
  serializeMetadata,
} from '../../../serialization/payload-v1'
import { makeMetadata } from './fixtures'

describe('serializeMetadata / deserializeMetadata', () => {
  it('roundtrips index metadata', () => {
    const original = makeMetadata()
    const bytes = serializeMetadata(original)
    const restored = deserializeMetadata(bytes)

    expect(restored.indexName).toBe(original.indexName)
    expect(restored.schema).toEqual(original.schema)
    expect(restored.language).toBe(original.language)
    expect(restored.partitionCount).toBe(original.partitionCount)
    expect(restored.bm25Params).toEqual(original.bm25Params)
    expect(restored.createdAt).toBe(original.createdAt)
    expect(restored.engineVersion).toBe(original.engineVersion)
  })

  it('fills defaults for missing optional fields', () => {
    const bytes = serializeMetadata(makeMetadata())
    const restored = deserializeMetadata(bytes)
    expect(restored.language).toBe('english')
    expect(restored.partitionCount).toBeGreaterThanOrEqual(1)
  })

  it('handles custom BM25 parameters', () => {
    const original = makeMetadata({ bm25Params: { k1: 1.5, b: 0.5 } })
    const restored = deserializeMetadata(serializeMetadata(original))
    expect(restored.bm25Params.k1).toBeCloseTo(1.5)
    expect(restored.bm25Params.b).toBeCloseTo(0.5)
  })

  it('persists the surface-forms setting and omits it when off', () => {
    const enabled = deserializeMetadata(serializeMetadata({ ...makeMetadata(), surfaceForms: true }))
    expect(enabled.surfaceForms).toBe(true)

    const disabled = deserializeMetadata(serializeMetadata(makeMetadata()))
    expect(disabled.surfaceForms).toBeUndefined()
  })
})

describe('payload-v1 backward compat: vector_data read path', () => {
  it('deserializes legacy wire payloads that contain vector_data', () => {
    const wire: RawPartitionPayload = {
      index_name: 'vectors',
      partition_id: 0,
      total_partitions: 1,
      language: 'english',
      schema: { embedding: 'vector[3]' },
      doc_count: 1,
      avg_doc_length: 0,
      documents: {
        'doc-1': { fields: {}, field_lengths: {} },
      },
      inverted_index: {},
      field_indexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [{ doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] }],
          hnsw_graph: {
            entry_point: 'doc-1',
            max_layer: 1,
            m: 16,
            ef_construction: 200,
            metric: 'euclidean',
            nodes: [['doc-1', 1, [[0, []]]]],
          },
        },
      },
      statistics: {
        total_documents: 1,
        total_field_lengths: {},
        average_field_lengths: {},
        doc_frequencies: {},
      },
    }
    const bytes = encodeRawPayload(wire)
    const restored = deserializePayloadV1(bytes)

    const vectorData = restored.vectorData
    if (!vectorData) throw new Error('expected restored.vectorData to be defined')
    expect(vectorData.embedding.dimension).toBe(3)
    expect(vectorData.embedding.vectors).toHaveLength(1)
    expect(vectorData.embedding.vectors[0].docId).toBe('doc-1')
    expect(vectorData.embedding.hnswGraph?.metric).toBe('euclidean')
  })

  it('treats an unrecognized hnsw_graph metric as undefined', () => {
    const wire: RawPartitionPayload = {
      index_name: 'vectors',
      partition_id: 0,
      total_partitions: 1,
      language: 'english',
      schema: { embedding: 'vector[3]' },
      doc_count: 1,
      avg_doc_length: 0,
      documents: {
        'doc-1': { fields: {}, field_lengths: {} },
      },
      inverted_index: {},
      field_indexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [{ doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] }],
          hnsw_graph: {
            entry_point: 'doc-1',
            max_layer: 1,
            m: 16,
            ef_construction: 200,
            metric: 'manhattan',
            nodes: [['doc-1', 1, [[0, []]]]],
          },
        },
      },
      statistics: {
        total_documents: 1,
        total_field_lengths: {},
        average_field_lengths: {},
        doc_frequencies: {},
      },
    }
    const bytes = encodeRawPayload(wire)
    const restored = deserializePayloadV1(bytes)

    const vectorData = restored.vectorData
    if (!vectorData) throw new Error('expected restored.vectorData to be defined')
    expect(vectorData.embedding.hnswGraph?.metric).toBeUndefined()
  })

  it('deserializes vector_data with sq8 quantization data', () => {
    const wire: RawPartitionPayload = {
      index_name: 'quantized',
      partition_id: 0,
      total_partitions: 1,
      language: 'english',
      schema: { embedding: 'vector[3]' },
      doc_count: 1,
      avg_doc_length: 0,
      documents: {
        'doc-1': { fields: {}, field_lengths: {} },
      },
      inverted_index: {},
      field_indexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [{ doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] }],
          hnsw_graph: null,
          sq8: {
            alpha: 0.5,
            offset: 0.1,
            quantized_vectors: { 'doc-1': [128, 180, 230] },
            vector_sums: { 'doc-1': 0.6 },
            vector_sum_sqs: { 'doc-1': 0.14 },
          },
        },
      },
      statistics: {
        total_documents: 1,
        total_field_lengths: {},
        average_field_lengths: {},
        doc_frequencies: {},
      },
    }
    const bytes = encodeRawPayload(wire)
    const restored = deserializePayloadV1(bytes)

    const vectorData = restored.vectorData
    if (!vectorData) throw new Error('expected restored.vectorData to be defined')
    const sq8 = vectorData.embedding.sq8
    expect(sq8).not.toBeNull()
    if (sq8) {
      expect(sq8.alpha).toBeCloseTo(0.5)
      expect(sq8.offset).toBeCloseTo(0.1)
      expect(sq8.quantizedVectors['doc-1']).toEqual([128, 180, 230])
      expect(sq8.vectorSums['doc-1']).toBeCloseTo(0.6)
      expect(sq8.vectorSumSqs['doc-1']).toBeCloseTo(0.14)
    }
  })
})

describe('metadata with vector fields', () => {
  it('roundtrips metadata containing vectorFields', () => {
    const original = makeMetadata({
      vectorFields: {
        embedding: { dimension: 1536, metric: 'cosine', quantization: 'sq8' },
      },
    })
    const bytes = serializeMetadata(original)
    const restored = deserializeMetadata(bytes)

    expect(restored.vectorFields).toBeDefined()
    if (restored.vectorFields) {
      expect(restored.vectorFields.embedding.dimension).toBe(1536)
      expect(restored.vectorFields.embedding.metric).toBe('cosine')
      expect(restored.vectorFields.embedding.quantization).toBe('sq8')
    }
  })

  it('omits vectorFields when not present in original metadata', () => {
    const original = makeMetadata()
    const bytes = serializeMetadata(original)
    const restored = deserializeMetadata(bytes)

    expect(restored.vectorFields).toBeUndefined()
  })
})

describe('wireToPartition fallback branches for missing fields', () => {
  it('uses fallback defaults when optional partition fields are absent', () => {
    const sparse = {
      index_name: 'sparse-index',
      partition_id: 0,
      total_partitions: 1,
    }
    const bytes = encode(sparse)
    const restored = deserializePayloadV1(new Uint8Array(bytes))

    expect(restored.language).toBe('english')
    expect(restored.schema).toEqual({})
    expect(restored.docCount).toBe(0)
    expect(restored.avgDocLength).toBe(0)
    expect(Object.keys(restored.documents)).toHaveLength(0)
    expect(Object.keys(restored.invertedIndex)).toHaveLength(0)
    expect(restored.fieldIndexes.enum).toEqual({})
    expect(restored.statistics.totalDocuments).toBe(0)
    expect(restored.statistics.totalFieldLengths).toEqual({})
    expect(restored.statistics.averageFieldLengths).toEqual({})
    expect(restored.statistics.docFrequencies).toEqual({})
  })

  it('uses fallback for missing field_lengths in documents', () => {
    const wire = {
      index_name: 'test',
      partition_id: 0,
      total_partitions: 1,
      documents: {
        'doc-1': { fields: { title: 'hello' } },
      },
    }
    const bytes = encode(wire)
    const restored = deserializePayloadV1(new Uint8Array(bytes))

    expect(restored.documents['doc-1'].fieldLengths).toEqual({})
    expect(restored.documents['doc-1'].fields.title).toBe('hello')
  })

  it('uses fallback for missing positions in posting entries', () => {
    const wire = {
      index_name: 'test',
      partition_id: 0,
      total_partitions: 1,
      inverted_index: {
        hello: {
          doc_freq: 1,
          postings: [{ doc_id: 'doc-1', term_freq: 1, field: 'title' }],
        },
      },
    }
    const bytes = encode(wire)
    const restored = deserializePayloadV1(new Uint8Array(bytes))

    expect(restored.invertedIndex.hello.postings[0].positions).toEqual([])
  })

  it('uses fallback for missing boolean true_docs and false_docs', () => {
    const wire = {
      index_name: 'test',
      partition_id: 0,
      total_partitions: 1,
      field_indexes: {
        boolean: { inStock: {} },
      },
    }
    const bytes = encode(wire)
    const restored = deserializePayloadV1(new Uint8Array(bytes))

    expect(restored.fieldIndexes.boolean.inStock.trueDocs).toEqual([])
    expect(restored.fieldIndexes.boolean.inStock.falseDocs).toEqual([])
  })
})

describe('wireToMetadata fallback branches for missing fields', () => {
  it('uses fallback defaults when optional metadata fields are absent', () => {
    const sparse = { index_name: 'sparse-meta' }
    const bytes = encode(sparse)
    const restored = deserializeMetadata(new Uint8Array(bytes))

    expect(restored.indexName).toBe('sparse-meta')
    expect(restored.schema).toEqual({})
    expect(restored.language).toBe('english')
    expect(restored.partitionCount).toBe(1)
    expect(restored.bm25Params).toEqual({ k1: 1.2, b: 0.75 })
    expect(restored.createdAt).toBe(0)
    expect(restored.engineVersion).toBe('0.0.0')
    expect(restored.vectorFields).toBeUndefined()
  })
})
