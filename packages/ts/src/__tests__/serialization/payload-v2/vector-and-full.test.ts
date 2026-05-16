import { describe, expect, it } from 'vitest'
import { deserializePayloadV2, encodeRawPayloadV2, type RawPartitionPayloadV2 } from '../../../serialization/payload-v2'
import { makeMinimalPayload, roundtrip } from './fixtures'

describe('encodeRawPayloadV2 / deserializePayloadV2 - vector data and full payloads', () => {
  it('roundtrips a payload with vector data and HNSW graph (no SQ8)', () => {
    const wire = makeMinimalPayload({
      schema: { embedding: 'vector[3]' },
      doc_count: 1,
      documents: {
        'doc-1': { fields: {}, field_lengths: {} },
      },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [{ doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] }],
          hnsw_graph: {
            entry_point: 'doc-1',
            max_layer: 1,
            m: 16,
            ef_construction: 200,
            metric: 'cosine',
            nodes: [['doc-1', 1, [[0, []]]]],
          },
        },
      },
    })
    const restored = roundtrip(wire)

    const vec = restored.vectorData?.embedding
    expect(vec).toBeDefined()
    if (!vec) return

    expect(vec.dimension).toBe(3)
    expect(vec.vectors).toHaveLength(1)
    expect(vec.vectors[0].docId).toBe('doc-1')
    expect(vec.vectors[0].vector).toEqual([0.1, 0.2, 0.3])
    expect(vec.hnswGraph).toBeDefined()
    if (!vec.hnswGraph) return

    expect(vec.hnswGraph.entryPoint).toBe('doc-1')
    expect(vec.hnswGraph.maxLayer).toBe(1)
    expect(vec.hnswGraph.m).toBe(16)
    expect(vec.hnswGraph.efConstruction).toBe(200)
    expect(vec.hnswGraph.metric).toBe('cosine')
    expect(vec.hnswGraph.nodes).toEqual([['doc-1', 1, [[0, []]]]])
    expect(vec.sq8).toBeNull()
  })

  it('roundtrips a payload with vector data, HNSW graph, and SQ8 quantization', () => {
    const wire = makeMinimalPayload({
      schema: { embedding: 'vector[3]' },
      doc_count: 2,
      documents: {
        'doc-1': { fields: {}, field_lengths: {} },
        'doc-2': { fields: {}, field_lengths: {} },
      },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [
            { doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] },
            { doc_id: 'doc-2', vector: [0.4, 0.5, 0.6] },
          ],
          hnsw_graph: {
            entry_point: 'doc-1',
            max_layer: 2,
            m: 16,
            ef_construction: 200,
            metric: 'euclidean',
            nodes: [
              [
                'doc-1',
                2,
                [
                  [0, ['doc-2']],
                  [1, []],
                ],
              ],
              ['doc-2', 1, [[0, ['doc-1']]]],
            ],
          },
          sq8: {
            alpha: 0.5,
            offset: 0.1,
            quantized_vectors: { 'doc-1': [10, 20, 30], 'doc-2': [40, 50, 60] },
            vector_sums: { 'doc-1': 0.6, 'doc-2': 1.5 },
            vector_sum_sqs: { 'doc-1': 0.14, 'doc-2': 0.77 },
          },
        },
      },
    })
    const restored = roundtrip(wire)

    const vec = restored.vectorData?.embedding
    expect(vec).toBeDefined()
    if (!vec) return

    expect(vec.sq8).toBeDefined()
    if (!vec.sq8) return

    expect(vec.sq8.alpha).toBeCloseTo(0.5)
    expect(vec.sq8.offset).toBeCloseTo(0.1)
    expect(vec.sq8.quantizedVectors['doc-1']).toEqual([10, 20, 30])
    expect(vec.sq8.quantizedVectors['doc-2']).toEqual([40, 50, 60])
    expect(vec.sq8.vectorSums['doc-1']).toBeCloseTo(0.6)
    expect(vec.sq8.vectorSumSqs['doc-2']).toBeCloseTo(0.77)
  })

  it('handles null and missing optional fields gracefully', () => {
    const wire = makeMinimalPayload({
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [],
          hnsw_graph: null,
          sq8: null,
        },
      },
    })
    const restored = roundtrip(wire)

    const vec = restored.vectorData?.embedding
    expect(vec).toBeDefined()
    if (!vec) return

    expect(vec.hnswGraph).toBeNull()
    expect(vec.sq8).toBeNull()
  })

  it('roundtrips a full payload with all field types combined', () => {
    const wire: RawPartitionPayloadV2 = {
      v: 2,
      index_name: 'catalog',
      partition_id: 1,
      total_partitions: 8,
      language: 'english',
      schema: {
        title: 'string',
        price: 'number',
        inStock: 'boolean',
        category: 'enum',
        location: 'geopoint',
        embedding: 'vector[3]',
      },
      doc_count: 2,
      avg_doc_length: 2.5,
      documents: {
        'doc-1': {
          fields: {
            title: 'wireless headphones',
            price: 49.99,
            inStock: true,
            category: 'electronics',
            location: { lat: 5.6037, lon: -0.187 },
          },
          field_lengths: { title: 2 },
        },
        'doc-2': {
          fields: {
            title: 'running shoes',
            price: 89.95,
            inStock: false,
            category: 'footwear',
            location: { lat: 51.5074, lon: -0.1278 },
          },
          field_lengths: { title: 2 },
        },
      },
      inverted_index: {
        field_names: ['title'],
        entries: {
          wireless: { df: 1, ids: ['doc-1'], tf: [1], fi: new Uint8Array([0]), pos: [[0]] },
          headphon: { df: 1, ids: ['doc-1'], tf: [1], fi: new Uint8Array([0]), pos: [[1]] },
          run: { df: 1, ids: ['doc-2'], tf: [1], fi: new Uint8Array([0]), pos: [[0]] },
          shoe: { df: 1, ids: ['doc-2'], tf: [1], fi: new Uint8Array([0]), pos: [[1]] },
        },
      },
      field_indexes: {
        numeric: {
          price: [
            { value: 49.99, doc_id: 'doc-1' },
            { value: 89.95, doc_id: 'doc-2' },
          ],
        },
        boolean: { inStock: { true_docs: ['doc-1'], false_docs: ['doc-2'] } },
        enum: { category: { electronics: ['doc-1'], footwear: ['doc-2'] } },
        geopoint: {
          location: [
            { lat: 5.6037, lon: -0.187, doc_id: 'doc-1' },
            { lat: 51.5074, lon: -0.1278, doc_id: 'doc-2' },
          ],
        },
      },
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [
            { doc_id: 'doc-1', vector: [0.1, 0.2, 0.3] },
            { doc_id: 'doc-2', vector: [0.4, 0.5, 0.6] },
          ],
          hnsw_graph: {
            entry_point: 'doc-1',
            max_layer: 1,
            m: 16,
            ef_construction: 200,
            metric: 'dotProduct',
            nodes: [
              ['doc-1', 1, [[0, ['doc-2']]]],
              ['doc-2', 0, [[0, ['doc-1']]]],
            ],
          },
          sq8: {
            alpha: 0.3,
            offset: 0.05,
            quantized_vectors: { 'doc-1': [10, 20, 30], 'doc-2': [40, 50, 60] },
            vector_sums: { 'doc-1': 0.6, 'doc-2': 1.5 },
            vector_sum_sqs: { 'doc-1': 0.14, 'doc-2': 0.77 },
          },
        },
      },
      statistics: {
        total_documents: 2,
        total_field_lengths: { title: 4 },
        average_field_lengths: { title: 2 },
        doc_frequencies: { wireless: 1, headphon: 1, run: 1, shoe: 1 },
      },
    }

    const restored = roundtrip(wire)

    expect(restored.indexName).toBe('catalog')
    expect(restored.partitionId).toBe(1)
    expect(restored.totalPartitions).toBe(8)
    expect(restored.docCount).toBe(2)
    expect(restored.avgDocLength).toBeCloseTo(2.5)

    expect(restored.documents['doc-1'].fields.title).toBe('wireless headphones')
    expect(restored.documents['doc-1'].fields.price).toBe(49.99)
    expect(restored.documents['doc-1'].fieldLengths.title).toBe(2)
    expect(restored.documents['doc-2'].fields.category).toBe('footwear')

    expect(Object.keys(restored.invertedIndex)).toHaveLength(4)
    expect(restored.invertedIndex.wireless.docFrequency).toBe(1)
    expect(restored.invertedIndex.wireless.postings[0].field).toBe('title')

    expect(restored.fieldIndexes.numeric.price).toHaveLength(2)
    expect(restored.fieldIndexes.boolean.inStock.trueDocs).toEqual(['doc-1'])
    expect(restored.fieldIndexes.enum.category.electronics).toEqual(['doc-1'])
    expect(restored.fieldIndexes.geopoint.location).toHaveLength(2)

    const vec = restored.vectorData?.embedding
    expect(vec).toBeDefined()
    if (!vec) return

    expect(vec.dimension).toBe(3)
    expect(vec.vectors).toHaveLength(2)
    expect(vec.hnswGraph?.metric).toBe('dotProduct')
    expect(vec.sq8?.alpha).toBeCloseTo(0.3)

    expect(restored.statistics.totalDocuments).toBe(2)
    expect(restored.statistics.totalFieldLengths.title).toBe(4)
    expect(restored.statistics.averageFieldLengths.title).toBe(2)
    expect(restored.statistics.docFrequencies.wireless).toBe(1)
  })

  it('preserves document field lengths across the round-trip', () => {
    const wire = makeMinimalPayload({
      doc_count: 1,
      documents: {
        'doc-1': {
          fields: { title: 'noise cancelling headphones' },
          field_lengths: { title: 3 },
        },
      },
    })
    const restored = roundtrip(wire)

    expect(restored.documents['doc-1'].fields.title).toBe('noise cancelling headphones')
    expect(restored.documents['doc-1'].fieldLengths.title).toBe(3)
  })

  it('produces compact binary output compared to JSON', () => {
    const wire: RawPartitionPayloadV2 = {
      v: 2,
      index_name: 'products',
      partition_id: 0,
      total_partitions: 1,
      language: 'english',
      schema: { title: 'string', price: 'number' },
      doc_count: 2,
      avg_doc_length: 2,
      documents: {
        'doc-1': { fields: { title: 'headphones', price: 50 }, field_lengths: { title: 1 } },
        'doc-2': { fields: { title: 'keyboard', price: 80 }, field_lengths: { title: 1 } },
      },
      inverted_index: {
        field_names: ['title'],
        entries: {
          headphon: { df: 1, ids: ['doc-1'], tf: [1], fi: new Uint8Array([0]), pos: [[0]] },
          keyboard: { df: 1, ids: ['doc-2'], tf: [1], fi: new Uint8Array([0]), pos: [[0]] },
        },
      },
      field_indexes: {
        numeric: {
          price: [
            { value: 50, doc_id: 'doc-1' },
            { value: 80, doc_id: 'doc-2' },
          ],
        },
        boolean: {},
        enum: {},
        geopoint: {},
      },
      statistics: {
        total_documents: 2,
        total_field_lengths: { title: 2 },
        average_field_lengths: { title: 1 },
        doc_frequencies: { headphon: 1, keyboard: 1 },
      },
    }
    const bytes = encodeRawPayloadV2(wire)
    const json = new TextEncoder().encode(JSON.stringify(wire))
    expect(bytes.length).toBeLessThan(json.length)
  })

  it('resolves inverted index field names from the field_names array', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', description: 'string' },
      doc_count: 1,
      documents: {
        'doc-1': {
          fields: { title: 'laptop', description: 'fast laptop for work' },
          field_lengths: { title: 1, description: 4 },
        },
      },
      inverted_index: {
        field_names: ['title', 'description'],
        entries: {
          laptop: {
            df: 2,
            ids: ['doc-1', 'doc-1'],
            tf: [1, 1],
            fi: new Uint8Array([0, 1]),
            pos: [[0], [1]],
          },
        },
      },
    })
    const restored = roundtrip(wire)

    const postings = restored.invertedIndex.laptop.postings
    expect(postings).toHaveLength(2)
    expect(postings[0].field).toBe('title')
    expect(postings[1].field).toBe('description')
  })

  it('handles inverted index entries with null positions', () => {
    const wire = makeMinimalPayload({
      doc_count: 1,
      documents: {
        'doc-1': { fields: { title: 'test' }, field_lengths: { title: 1 } },
      },
      inverted_index: {
        field_names: ['title'],
        entries: {
          test: {
            df: 1,
            ids: ['doc-1'],
            tf: [1],
            fi: new Uint8Array([0]),
            pos: null,
          },
        },
      },
    })
    const restored = roundtrip(wire)

    expect(restored.invertedIndex.test.postings[0].positions).toEqual([])
  })

  it('defaults language to english when missing from the wire format', () => {
    const wire = makeMinimalPayload()
    const raw = { ...wire } as Record<string, unknown>
    delete raw.language

    const bytes = encodeRawPayloadV2(raw as unknown as RawPartitionPayloadV2)
    const restored = deserializePayloadV2(bytes)
    expect(restored.language).toBe('english')
  })
})
