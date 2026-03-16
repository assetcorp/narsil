import { afterAll, beforeAll, bench, describe } from 'vitest'
import { createNarsil, type Narsil } from '../src/narsil'
import type { IndexConfig, SchemaDefinition } from '../src/types/schema'
import { generateDocuments, generateQueries } from './utils'

const SEED = 42
const DOC_COUNT = 50_000
const QUERY_POOL_SIZE = 200

const schema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  score: 'number' as const,
  category: 'enum' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
  partitions: {
    maxDocsPerPartition: 10_000,
    maxPartitions: 8,
  },
}

const queries = generateQueries(QUERY_POOL_SIZE, SEED + 1)
let queryIndex = 0

function nextQuery(): string {
  const q = queries[queryIndex % queries.length]
  queryIndex++
  return q
}

let narsil: Narsil

describe('Search Latency (50K documents, multi-partition)', () => {
  beforeAll(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('bench', indexConfig)
    const docs = generateDocuments(DOC_COUNT, SEED, { includeCategory: true })
    await narsil.insertBatch('bench', docs)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  bench('fulltext search', async () => {
    await narsil.query('bench', { term: nextQuery() })
  })

  bench('fulltext search with range filter', async () => {
    await narsil.query('bench', {
      term: nextQuery(),
      filters: {
        fields: {
          score: { gte: 20, lte: 80 },
        },
      },
    })
  })

  bench('fulltext search with sorting', async () => {
    await narsil.query('bench', {
      term: nextQuery(),
      sort: { score: 'desc' },
    })
  })

  bench('fulltext search with facets', async () => {
    await narsil.query('bench', {
      term: nextQuery(),
      facets: { category: {} },
    })
  })

  bench('fulltext search with enum filter', async () => {
    await narsil.query('bench', {
      term: nextQuery(),
      filters: {
        fields: {
          category: { eq: 'engineering' },
        },
      },
    })
  })

  bench('combined: filter + sort + facets', async () => {
    await narsil.query('bench', {
      term: nextQuery(),
      filters: {
        fields: {
          score: { gte: 30, lte: 70 },
          category: { eq: 'research' },
        },
      },
      sort: { score: 'desc' },
      facets: { category: {} },
    })
  })

  bench('preflight query', async () => {
    await narsil.preflight('bench', { term: nextQuery() })
  })
})
