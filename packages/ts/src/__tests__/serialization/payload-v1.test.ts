import { describe, expect, it } from 'vitest'
import {
  deserializeMetadata,
  deserializePayloadV1,
  encodeRawPayload,
  type RawPartitionPayload,
  serializeMetadata,
  serializePayloadV1,
} from '../../serialization/payload-v1'
import type { IndexMetadata, SerializablePartition } from '../../types/internal'

function makePartition(overrides: Partial<SerializablePartition> = {}): SerializablePartition {
  return {
    indexName: 'products',
    partitionId: 0,
    totalPartitions: 4,
    language: 'english',
    schema: { title: 'string', price: 'number', inStock: 'boolean', category: 'enum' },
    docCount: 2,
    avgDocLength: 3.5,
    documents: {
      'doc-1': {
        fields: { title: 'wireless headphones', price: 49.99, inStock: true, category: 'electronics' },
        fieldLengths: { title: 2 },
      },
      'doc-2': {
        fields: { title: 'running shoes', price: 89.95, inStock: false, category: 'footwear' },
        fieldLengths: { title: 2 },
      },
    },
    invertedIndex: {
      wireless: {
        docFrequency: 1,
        postings: [{ docId: 'doc-1', termFrequency: 1, field: 'title', positions: [0] }],
      },
      headphon: {
        docFrequency: 1,
        postings: [{ docId: 'doc-1', termFrequency: 1, field: 'title', positions: [1] }],
      },
      run: {
        docFrequency: 1,
        postings: [{ docId: 'doc-2', termFrequency: 1, field: 'title', positions: [0] }],
      },
      shoe: {
        docFrequency: 1,
        postings: [{ docId: 'doc-2', termFrequency: 1, field: 'title', positions: [1] }],
      },
    },
    fieldIndexes: {
      numeric: {
        price: [
          { value: 49.99, docId: 'doc-1' },
          { value: 89.95, docId: 'doc-2' },
        ],
      },
      boolean: {
        inStock: { trueDocs: ['doc-1'], falseDocs: ['doc-2'] },
      },
      enum: {
        category: {
          electronics: ['doc-1'],
          footwear: ['doc-2'],
        },
      },
      geopoint: {},
    },
    vectorData: {},
    statistics: {
      totalDocuments: 2,
      totalFieldLengths: { title: 4 },
      averageFieldLengths: { title: 2 },
      docFrequencies: { wireless: 1, headphon: 1, run: 1, shoe: 1 },
    },
    ...overrides,
  }
}

function makeMetadata(overrides: Partial<IndexMetadata> = {}): IndexMetadata {
  return {
    indexName: 'products',
    schema: { title: 'string', price: 'number', inStock: 'boolean' },
    language: 'english',
    partitionCount: 4,
    bm25Params: { k1: 1.2, b: 0.75 },
    createdAt: 1700000000000,
    engineVersion: '0.1.0',
    ...overrides,
  }
}

describe('serializePayloadV1 / deserializePayloadV1', () => {
  it('roundtrips a partition with documents, inverted index, and field indexes', () => {
    const original = makePartition()
    const bytes = serializePayloadV1(original)
    const restored = deserializePayloadV1(bytes)

    expect(restored.indexName).toBe(original.indexName)
    expect(restored.partitionId).toBe(original.partitionId)
    expect(restored.totalPartitions).toBe(original.totalPartitions)
    expect(restored.language).toBe(original.language)
    expect(restored.schema).toEqual(original.schema)
    expect(restored.docCount).toBe(original.docCount)
    expect(restored.avgDocLength).toBeCloseTo(original.avgDocLength, 5)
  })

  it('preserves document fields and field lengths', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.documents['doc-1'].fields.title).toBe('wireless headphones')
    expect(restored.documents['doc-1'].fields.price).toBe(49.99)
    expect(restored.documents['doc-1'].fields.inStock).toBe(true)
    expect(restored.documents['doc-1'].fieldLengths.title).toBe(2)
    expect(restored.documents['doc-2'].fields.category).toBe('footwear')
  })

  it('preserves inverted index structure', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.invertedIndex.wireless.docFrequency).toBe(1)
    expect(restored.invertedIndex.wireless.postings).toHaveLength(1)
    expect(restored.invertedIndex.wireless.postings[0].docId).toBe('doc-1')
    expect(restored.invertedIndex.wireless.postings[0].termFrequency).toBe(1)
    expect(restored.invertedIndex.wireless.postings[0].field).toBe('title')
    expect(restored.invertedIndex.wireless.postings[0].positions).toEqual([0])
  })

  it('preserves numeric field index entries in order', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.fieldIndexes.numeric.price).toEqual([
      { value: 49.99, docId: 'doc-1' },
      { value: 89.95, docId: 'doc-2' },
    ])
  })

  it('preserves boolean field index', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.fieldIndexes.boolean.inStock.trueDocs).toEqual(['doc-1'])
    expect(restored.fieldIndexes.boolean.inStock.falseDocs).toEqual(['doc-2'])
  })

  it('preserves enum field index', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.fieldIndexes.enum.category.electronics).toEqual(['doc-1'])
    expect(restored.fieldIndexes.enum.category.footwear).toEqual(['doc-2'])
  })

  it('preserves statistics including doc frequencies', () => {
    const original = makePartition()
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.statistics.totalDocuments).toBe(2)
    expect(restored.statistics.totalFieldLengths.title).toBe(4)
    expect(restored.statistics.averageFieldLengths.title).toBe(2)
    expect(restored.statistics.docFrequencies.wireless).toBe(1)
  })

  it('roundtrips a partition with geopoint data', () => {
    const original = makePartition({
      fieldIndexes: {
        numeric: {},
        boolean: {},
        enum: {},
        geopoint: {
          location: [
            { lat: 5.6037, lon: -0.187, docId: 'doc-1' },
            { lat: 6.6885, lon: -1.6244, docId: 'doc-2' },
          ],
        },
      },
    })
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.fieldIndexes.geopoint.location).toHaveLength(2)
    expect(restored.fieldIndexes.geopoint.location[0].lat).toBeCloseTo(5.6037)
    expect(restored.fieldIndexes.geopoint.location[0].lon).toBeCloseTo(-0.187)
    expect(restored.fieldIndexes.geopoint.location[0].docId).toBe('doc-1')
  })

  it('roundtrips an empty partition', () => {
    const original = makePartition({
      docCount: 0,
      avgDocLength: 0,
      documents: {},
      invertedIndex: {},
      fieldIndexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
      vectorData: {},
      statistics: {
        totalDocuments: 0,
        totalFieldLengths: {},
        averageFieldLengths: {},
        docFrequencies: {},
      },
    })
    const restored = deserializePayloadV1(serializePayloadV1(original))

    expect(restored.docCount).toBe(0)
    expect(Object.keys(restored.documents)).toHaveLength(0)
    expect(Object.keys(restored.invertedIndex)).toHaveLength(0)
  })

  it('produces compact binary output', () => {
    const partition = makePartition()
    const bytes = serializePayloadV1(partition)
    const json = new TextEncoder().encode(JSON.stringify(partition))
    expect(bytes.length).toBeLessThan(json.length)
  })
})

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

    expect(restored.vectorData.embedding.dimension).toBe(3)
    expect(restored.vectorData.embedding.vectors).toHaveLength(1)
    expect(restored.vectorData.embedding.vectors[0].docId).toBe('doc-1')
    expect(restored.vectorData.embedding.hnswGraph?.metric).toBe('euclidean')
  })
})
