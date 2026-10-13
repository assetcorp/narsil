import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../core/partition'
import { deserializePayloadV1 } from '../../serialization/payload-v1'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const stemming: LanguageModule = {
  name: 'test-stemming',
  revision: '1',
  stemmer: (word: string) => word.replace(/(?:ing|ity|ies|s)$/u, ''),
  stopWords: new Set(['the']),
}

const schema: SchemaDefinition = { title: 'string' }

function buildPartition() {
  const partition = createPartitionIndex(0)
  partition.insert('d1', { title: 'security running fox' }, schema, stemming, { collectSurfaces: true })
  partition.insert('d2', { title: 'security fox' }, schema, stemming, { collectSurfaces: true })
  return partition
}

function earlierPayload(surfaceForms: unknown, version: 1 | 2): Uint8Array {
  return encode({
    ...(version === 2 ? { v: 2, inverted_index: { field_names: [], entries: {} } } : { inverted_index: {} }),
    index_name: 'idx',
    partition_id: 0,
    total_partitions: 1,
    language: 'test-stemming',
    schema,
    doc_count: 0,
    avg_doc_length: 0,
    documents: {},
    field_indexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
    surface_forms: surfaceForms,
    statistics: { total_documents: 0, total_field_lengths: {}, average_field_lengths: {}, doc_frequencies: {} },
  })
}

describe('surface forms in serialized partitions', () => {
  it('serializes only stem-changed surfaces with their counts and tokens', () => {
    const serialized = buildPartition().serialize('idx', 1, 'test-stemming', schema)

    expect(serialized.surfaceForms?.security).toEqual([2, 'secur'])
    expect(serialized.surfaceForms?.running).toEqual([1, 'runn'])
    expect(serialized.surfaceForms?.fox).toBeUndefined()
  })

  it('suggests the surface a partition read back holds', () => {
    const serialized = buildPartition().serialize('idx', 1, 'test-stemming', schema)
    const restored = createPartitionIndex(0)
    restored.deserialize(serialized, schema)

    const suggestions = restored.suggestTerms('secur', 'secur', 10)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].surfaces.map(s => s.surface)).toEqual(['security'])
    expect(suggestions[0].documentFrequency).toBe(2)
  })

  it('reads the surface forms of both earlier partition payloads', () => {
    const forms = { security: [2, 'secur'], running: [1, 'runn'] }

    expect(deserializePayloadV1(earlierPayload(forms, 1)).surfaceForms).toEqual(forms)
    expect(deserializePayloadV2(earlierPayload(forms, 2)).surfaceForms).toEqual(forms)
  })

  it('falls back to index terms for a partition with no surface forms', () => {
    const serialized = buildPartition().serialize('idx', 1, 'test-stemming', schema)
    serialized.surfaceForms = undefined
    const restored = createPartitionIndex(0)
    restored.deserialize(serialized, schema)

    const suggestions = restored.suggestTerms('secur', 'secur', 10)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].surfaces.map(s => s.surface)).toEqual(['secur'])
  })

  it('drops malformed surface entries instead of failing the load', () => {
    const decoded = deserializePayloadV1(earlierPayload({ security: [2, 'secur'], broken: ['x', 42] }, 1))

    expect(decoded.surfaceForms?.broken).toBeUndefined()
    expect(decoded.surfaceForms?.security).toEqual([2, 'secur'])
  })
})
