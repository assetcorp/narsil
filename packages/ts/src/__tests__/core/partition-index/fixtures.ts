import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'

export const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

export const simpleSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
  active: 'boolean',
  category: 'enum',
}

export function makePartition(id = 0): PartitionIndex {
  return createPartitionIndex(id)
}
