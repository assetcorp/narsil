import { describe, expect, it } from 'vitest'
import { makeMinimalPayload, roundtrip } from './fixtures'

describe('encodeRawPayloadV2 / deserializePayloadV2 - basic round-trips', () => {
  it('roundtrips a minimal empty payload', () => {
    const wire = makeMinimalPayload()
    const restored = roundtrip(wire)

    expect(restored.indexName).toBe('products')
    expect(restored.partitionId).toBe(0)
    expect(restored.totalPartitions).toBe(4)
    expect(restored.language).toBe('english')
    expect(restored.schema).toEqual({ title: 'string' })
    expect(restored.docCount).toBe(0)
    expect(restored.avgDocLength).toBe(0)
    expect(Object.keys(restored.documents)).toHaveLength(0)
    expect(Object.keys(restored.invertedIndex)).toHaveLength(0)
  })

  it('roundtrips a payload with inverted index entries', () => {
    const wire = makeMinimalPayload({
      doc_count: 2,
      avg_doc_length: 3,
      documents: {
        'doc-1': { fields: { title: 'wireless headphones' }, field_lengths: { title: 2 } },
        'doc-2': { fields: { title: 'running shoes' }, field_lengths: { title: 2 } },
      },
      inverted_index: {
        field_names: ['title'],
        entries: {
          wireless: {
            df: 1,
            ids: ['doc-1'],
            tf: [1],
            fi: new Uint8Array([0]),
            pos: [[0]],
          },
          shoe: {
            df: 1,
            ids: ['doc-2'],
            tf: [1],
            fi: new Uint8Array([0]),
            pos: [[1]],
          },
        },
      },
    })
    const restored = roundtrip(wire)

    expect(restored.invertedIndex.wireless.docFrequency).toBe(1)
    expect(restored.invertedIndex.wireless.postings).toHaveLength(1)
    expect(restored.invertedIndex.wireless.postings[0].docId).toBe('doc-1')
    expect(restored.invertedIndex.wireless.postings[0].termFrequency).toBe(1)
    expect(restored.invertedIndex.wireless.postings[0].field).toBe('title')
    expect(restored.invertedIndex.wireless.postings[0].positions).toEqual([0])

    expect(restored.invertedIndex.shoe.docFrequency).toBe(1)
    expect(restored.invertedIndex.shoe.postings[0].docId).toBe('doc-2')
    expect(restored.invertedIndex.shoe.postings[0].positions).toEqual([1])
  })

  it('roundtrips a payload with numeric field index', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', price: 'number' },
      doc_count: 2,
      documents: {
        'doc-1': { fields: { title: 'laptop', price: 999.99 }, field_lengths: { title: 1 } },
        'doc-2': { fields: { title: 'keyboard', price: 79.5 }, field_lengths: { title: 1 } },
      },
      field_indexes: {
        numeric: {
          price: [
            { value: 79.5, doc_id: 'doc-2' },
            { value: 999.99, doc_id: 'doc-1' },
          ],
        },
        boolean: {},
        enum: {},
        geopoint: {},
      },
    })
    const restored = roundtrip(wire)

    expect(restored.fieldIndexes.numeric.price).toHaveLength(2)
    expect(restored.fieldIndexes.numeric.price[0]).toEqual({ value: 79.5, docId: 'doc-2' })
    expect(restored.fieldIndexes.numeric.price[1]).toEqual({ value: 999.99, docId: 'doc-1' })
  })

  it('roundtrips a payload with boolean field index', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', inStock: 'boolean' },
      field_indexes: {
        numeric: {},
        boolean: {
          inStock: { true_docs: ['doc-1', 'doc-3'], false_docs: ['doc-2'] },
        },
        enum: {},
        geopoint: {},
      },
    })
    const restored = roundtrip(wire)

    expect(restored.fieldIndexes.boolean.inStock.trueDocs).toEqual(['doc-1', 'doc-3'])
    expect(restored.fieldIndexes.boolean.inStock.falseDocs).toEqual(['doc-2'])
  })

  it('roundtrips a payload with enum field index', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', category: 'enum' },
      field_indexes: {
        numeric: {},
        boolean: {},
        enum: {
          category: {
            electronics: ['doc-1'],
            footwear: ['doc-2', 'doc-3'],
          },
        },
        geopoint: {},
      },
    })
    const restored = roundtrip(wire)

    expect(restored.fieldIndexes.enum.category.electronics).toEqual(['doc-1'])
    expect(restored.fieldIndexes.enum.category.footwear).toEqual(['doc-2', 'doc-3'])
  })

  it('roundtrips a payload with geopoint field index', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', location: 'geopoint' },
      field_indexes: {
        numeric: {},
        boolean: {},
        enum: {},
        geopoint: {
          location: [
            { lat: 5.6037, lon: -0.187, doc_id: 'doc-1' },
            { lat: 51.5074, lon: -0.1278, doc_id: 'doc-2' },
          ],
        },
      },
    })
    const restored = roundtrip(wire)

    expect(restored.fieldIndexes.geopoint.location).toHaveLength(2)
    expect(restored.fieldIndexes.geopoint.location[0].lat).toBeCloseTo(5.6037)
    expect(restored.fieldIndexes.geopoint.location[0].lon).toBeCloseTo(-0.187)
    expect(restored.fieldIndexes.geopoint.location[0].docId).toBe('doc-1')
    expect(restored.fieldIndexes.geopoint.location[1].lat).toBeCloseTo(51.5074)
    expect(restored.fieldIndexes.geopoint.location[1].docId).toBe('doc-2')
  })
})
