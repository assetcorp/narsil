import { afterAll, bench, describe } from 'vitest'
import { dbpediaDirectory, loadQueries, vectorOf } from './dbpedia/dataset'
import {
  createSingleThreadEngine,
  indexDirectory,
  PUBLISHED_EF_SEARCH,
  PUBLISHED_RRF_K,
  RESULT_COUNT,
  restoreIndex,
  TEXT_FIELD,
  VECTOR_FIELD,
  type VectorPrecision,
} from './dbpedia/indexes'

const QUERY_COUNT = 100

const queries = loadQueries(dbpediaDirectory(), QUERY_COUNT)
const queryVectors = queries.ids.map((_, row) => vectorOf(queries, row))
const narsil = await createSingleThreadEngine()
await restoreIndex(narsil, indexDirectory(), 'full-precision')
await restoreIndex(narsil, indexDirectory(), 'osq4')

function vectorClause(row: number) {
  return { field: VECTOR_FIELD, value: queryVectors[row], metric: 'cosine' as const, efSearch: PUBLISHED_EF_SEARCH }
}

async function vectorSearches(precision: VectorPrecision): Promise<void> {
  for (let row = 0; row < queryVectors.length; row++) {
    await narsil.query(precision, { mode: 'vector', vector: vectorClause(row), limit: RESULT_COUNT, document: false })
  }
}

async function hybridSearches(precision: VectorPrecision): Promise<void> {
  for (let row = 0; row < queryVectors.length; row++) {
    await narsil.query(precision, {
      mode: 'hybrid',
      term: queries.texts[row],
      fields: [TEXT_FIELD],
      vector: vectorClause(row),
      hybrid: { strategy: 'rrf', k: PUBLISHED_RRF_K },
      limit: RESULT_COUNT,
      document: false,
    })
  }
}

describe('search DBpedia 100K with 100 published queries, through the C search core', () => {
  afterAll(async () => {
    await narsil.shutdown()
  })

  bench('vector search at full precision, efSearch 128', () => vectorSearches('full-precision'))

  bench('vector search with 4-bit quantisation, efSearch 128', () => vectorSearches('osq4'))

  bench('hybrid search at full precision, efSearch 128', () => hybridSearches('full-precision'))

  bench('hybrid search with 4-bit quantisation, efSearch 128', () => hybridSearches('osq4'))

  bench('keyword search', async () => {
    for (const term of queries.texts) {
      await narsil.query('full-precision', { term, fields: [TEXT_FIELD], limit: RESULT_COUNT, document: false })
    }
  })
})
