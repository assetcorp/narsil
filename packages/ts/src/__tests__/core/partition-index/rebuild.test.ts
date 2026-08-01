import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../core/partition'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'

const schema: SchemaDefinition = { title: 'string', tags: 'string[]', price: 'number' }

const keepsWholeWords: LanguageModule = {
  name: 'rebuild-fixture',
  revision: '1',
  stemmer: null,
  stopWords: new Set<string>(),
}

const stripsProgressive: LanguageModule = {
  name: 'rebuild-fixture',
  revision: '2',
  stemmer: (token: string) => (token.endsWith('ing') ? token.slice(0, -3) : token),
  stopWords: new Set<string>(),
}

const dropsWater: LanguageModule = {
  name: 'rebuild-fixture',
  revision: '3',
  stemmer: null,
  stopWords: new Set(['water']),
}

function search(partition: ReturnType<typeof createPartitionIndex>, token: string): number {
  return partition.searchFulltext({ queryTokens: [{ token, position: 0 }] }).totalMatched
}

describe('rebuilding a partition from the documents it stores', () => {
  it('indexes the stored documents under the analysis it is given', () => {
    const partition = createPartitionIndex(0)
    partition.insert('a', { title: 'jumping water', price: 3 }, schema, keepsWholeWords)

    expect(search(partition, 'jumping')).toBe(1)
    expect(search(partition, 'jump')).toBe(0)

    partition.rebuildTextIndex(schema, stripsProgressive)

    expect(search(partition, 'jump')).toBe(1)
    expect(search(partition, 'jumping')).toBe(0)
  })

  it('drops a term the new analysis no longer produces', () => {
    const partition = createPartitionIndex(0)
    partition.insert('a', { title: 'jumping water', price: 3 }, schema, keepsWholeWords)
    expect(search(partition, 'water')).toBe(1)

    partition.rebuildTextIndex(schema, dropsWater)

    expect(search(partition, 'water')).toBe(0)
    expect(search(partition, 'jumping')).toBe(1)
  })

  it('keeps every document, its fields, and its identity', () => {
    const partition = createPartitionIndex(0)
    partition.insert('a', { title: 'jumping water', tags: ['running'], price: 3 }, schema, keepsWholeWords)
    partition.insert('b', { title: 'still water', tags: [], price: 5 }, schema, keepsWholeWords)

    partition.rebuildTextIndex(schema, stripsProgressive)

    expect(partition.count()).toBe(2)
    expect([...partition.docIds()]).toEqual(['a', 'b'])
    expect(partition.get('a')).toEqual({ title: 'jumping water', tags: ['running'], price: 3 })
    expect(search(partition, 'runn')).toBe(1)
  })

  it('recounts field lengths and document frequencies', () => {
    const partition = createPartitionIndex(0)
    partition.insert('a', { title: 'jumping water', price: 3 }, schema, keepsWholeWords)
    partition.insert('b', { title: 'water', price: 5 }, schema, keepsWholeWords)

    expect(partition.stats.docFrequencies.water).toBe(2)
    expect(partition.stats.totalFieldLengths.title).toBe(3)

    partition.rebuildTextIndex(schema, dropsWater)

    expect(partition.stats.totalDocuments).toBe(2)
    expect(partition.stats.docFrequencies.water).toBeUndefined()
    expect(partition.stats.docFrequencies.jumping).toBe(1)
    expect(partition.stats.totalFieldLengths.title).toBe(1)
    expect(partition.stats.averageFieldLengths.title).toBe(0.5)
  })

  it('leaves a partition holding no documents empty', () => {
    const partition = createPartitionIndex(0)
    partition.rebuildTextIndex(schema, stripsProgressive)

    expect(partition.count()).toBe(0)
    expect(partition.stats.totalDocuments).toBe(0)
  })
})
