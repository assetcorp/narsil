import type { PartitionIndex } from '../../../core/partition'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'

export const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to', 'it']),
}

export const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
  active: 'boolean',
  category: 'enum',
  tags: 'string[]',
}

export function populatePartition(partition: PartitionIndex): void {
  partition.insert(
    'doc1',
    {
      title: 'quick brown fox',
      body: 'the fox jumped over the fence',
      price: 10,
      active: true,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc2',
    {
      title: 'lazy dog sleeps',
      body: 'the dog rested under the tree',
      price: 20,
      active: true,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc3',
    {
      title: 'brown dog runs',
      body: 'the brown dog chased the fox',
      price: 30,
      active: false,
      category: 'animals',
    },
    schema,
    english,
  )
  partition.insert(
    'doc4',
    {
      title: 'search engines work',
      body: 'indexing documents for fast retrieval',
      price: 50,
      active: true,
      category: 'technology',
    },
    schema,
    english,
  )
}
