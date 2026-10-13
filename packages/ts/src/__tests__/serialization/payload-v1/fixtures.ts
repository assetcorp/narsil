import type { IndexMetadata } from '../../../types/internal'

export function makeMetadata(overrides: Partial<IndexMetadata> = {}): IndexMetadata {
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
