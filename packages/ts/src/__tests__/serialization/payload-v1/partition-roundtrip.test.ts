import { describe, expect, it } from 'vitest'
import { deserializePayloadV1, serializePayloadV1 } from '../../../serialization/payload-v1'
import { makePartition } from './fixtures'

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
