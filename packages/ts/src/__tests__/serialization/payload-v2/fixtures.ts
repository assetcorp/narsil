import { deserializePayloadV2, encodeRawPayloadV2, type RawPartitionPayloadV2 } from '../../../serialization/payload-v2'

export function makeMinimalPayload(overrides: Partial<RawPartitionPayloadV2> = {}): RawPartitionPayloadV2 {
  return {
    v: 2,
    index_name: 'products',
    partition_id: 0,
    total_partitions: 4,
    language: 'english',
    schema: { title: 'string' },
    doc_count: 0,
    avg_doc_length: 0,
    documents: {},
    inverted_index: { field_names: [], entries: {} },
    field_indexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
    statistics: {
      total_documents: 0,
      total_field_lengths: {},
      average_field_lengths: {},
      doc_frequencies: {},
    },
    ...overrides,
  }
}

export function roundtrip(wire: RawPartitionPayloadV2) {
  const bytes = encodeRawPayloadV2(wire)
  return deserializePayloadV2(bytes)
}
