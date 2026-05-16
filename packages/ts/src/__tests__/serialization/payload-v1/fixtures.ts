import type { IndexMetadata, SerializablePartition } from '../../../types/internal'

export function makePartition(overrides: Partial<SerializablePartition> = {}): SerializablePartition {
  return {
    indexName: 'products',
    partitionId: 0,
    totalPartitions: 4,
    language: 'english',
    schema: { title: 'string', price: 'number', inStock: 'boolean', category: 'enum' },
    docCount: 2,
    avgDocLength: 3.5,
    documents: {
      'doc-1': {
        fields: { title: 'wireless headphones', price: 49.99, inStock: true, category: 'electronics' },
        fieldLengths: { title: 2 },
      },
      'doc-2': {
        fields: { title: 'running shoes', price: 89.95, inStock: false, category: 'footwear' },
        fieldLengths: { title: 2 },
      },
    },
    invertedIndex: {
      wireless: {
        docFrequency: 1,
        postings: [{ docId: 'doc-1', termFrequency: 1, field: 'title', positions: [0] }],
      },
      headphon: {
        docFrequency: 1,
        postings: [{ docId: 'doc-1', termFrequency: 1, field: 'title', positions: [1] }],
      },
      run: {
        docFrequency: 1,
        postings: [{ docId: 'doc-2', termFrequency: 1, field: 'title', positions: [0] }],
      },
      shoe: {
        docFrequency: 1,
        postings: [{ docId: 'doc-2', termFrequency: 1, field: 'title', positions: [1] }],
      },
    },
    fieldIndexes: {
      numeric: {
        price: [
          { value: 49.99, docId: 'doc-1' },
          { value: 89.95, docId: 'doc-2' },
        ],
      },
      boolean: {
        inStock: { trueDocs: ['doc-1'], falseDocs: ['doc-2'] },
      },
      enum: {
        category: {
          electronics: ['doc-1'],
          footwear: ['doc-2'],
        },
      },
      geopoint: {},
    },
    vectorData: {},
    statistics: {
      totalDocuments: 2,
      totalFieldLengths: { title: 4 },
      averageFieldLengths: { title: 2 },
      docFrequencies: { wireless: 1, headphon: 1, run: 1, shoe: 1 },
    },
    ...overrides,
  }
}

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
