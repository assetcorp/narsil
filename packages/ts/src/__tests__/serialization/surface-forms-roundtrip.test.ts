import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../core/partition'
import { deserializePayloadV1, serializePayloadV1 } from '../../serialization/payload-v1'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const stemming: LanguageModule = {
  name: 'test-stemming',
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

describe('surface forms in serialized partitions', () => {
  it('serializes only stem-changed surfaces with their counts and tokens', () => {
    const partition = buildPartition()
    const serialized = partition.serialize('idx', 1, 'test-stemming', schema)

    expect(serialized.surfaceForms?.security).toEqual([2, 'secur'])
    expect(serialized.surfaceForms?.running).toEqual([1, 'runn'])
    expect(serialized.surfaceForms?.fox).toBeUndefined()
  })

  it('round-trips surface forms through payload v1', () => {
    const partition = buildPartition()
    const serialized = partition.serialize('idx', 1, 'test-stemming', schema)
    const decoded = deserializePayloadV1(serializePayloadV1(serialized))

    expect(decoded.surfaceForms).toEqual(serialized.surfaceForms)

    const restored = createPartitionIndex(0)
    restored.deserialize(decoded, schema)
    const suggestions = restored.suggestTerms('secur', 'secur', 10)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].surfaces.map(s => s.surface)).toEqual(['security'])
    expect(suggestions[0].documentFrequency).toBe(2)
  })

  it('round-trips surface forms through payload v2', () => {
    const partition = buildPartition()
    const bytes = partition.serializeToBytes('idx', 1, 'test-stemming', schema)
    const decoded = deserializePayloadV2(bytes)

    expect(decoded.surfaceForms?.security).toEqual([2, 'secur'])
    expect(decoded.surfaceForms?.fox).toBeUndefined()
  })

  it('loads payloads without surface forms and falls back to index terms', () => {
    const partition = buildPartition()
    const serialized = partition.serialize('idx', 1, 'test-stemming', schema)
    serialized.surfaceForms = undefined
    const decoded = deserializePayloadV1(serializePayloadV1(serialized))
    expect(decoded.surfaceForms).toBeUndefined()

    const restored = createPartitionIndex(0)
    restored.deserialize(decoded, schema)
    const suggestions = restored.suggestTerms('secur', 'secur', 10)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].surfaces.map(s => s.surface)).toEqual(['secur'])
  })

  it('drops malformed surface entries instead of failing the load', () => {
    const partition = buildPartition()
    const serialized = partition.serialize('idx', 1, 'test-stemming', schema)
    const tampered = {
      ...serialized,
      surfaceForms: { ...serialized.surfaceForms, broken: ['x', 42] as unknown as [number, string] },
    }
    const decoded = deserializePayloadV1(serializePayloadV1(tampered))
    expect(decoded.surfaceForms?.broken).toBeUndefined()
    expect(decoded.surfaceForms?.security).toEqual([2, 'secur'])
  })
})
