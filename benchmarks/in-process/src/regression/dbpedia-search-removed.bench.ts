import { afterAll, bench, describe } from 'vitest'
import { dbpediaDirectory, loadDocumentIds, loadQueries, vectorOf } from './dbpedia/dataset'
import {
  createSingleThreadEngine,
  indexDirectory,
  PUBLISHED_EF_SEARCH,
  RESULT_COUNT,
  restoreIndex,
  VECTOR_FIELD,
  VECTOR_PRECISIONS,
  type VectorPrecision,
} from './dbpedia/indexes'

const QUERY_COUNT = 100
const REMOVED_EVERY = 2

const directory = dbpediaDirectory()
const queries = loadQueries(directory, QUERY_COUNT)
const queryVectors = queries.ids.map((_, row) => vectorOf(queries, row))
const removed = loadDocumentIds(directory).filter((_, row) => row % REMOVED_EVERY === 0)
const narsil = await createSingleThreadEngine()
for (const precision of VECTOR_PRECISIONS) {
  await restoreIndex(narsil, indexDirectory(), precision)
  const result = await narsil.removeBatch(precision, removed)
  if (result.failed.length > 0) {
    throw new Error(`Narsil refused to remove ${result.failed.length} documents from the ${precision} index`)
  }
}

async function vectorSearches(precision: VectorPrecision): Promise<void> {
  for (let row = 0; row < queryVectors.length; row++) {
    await narsil.query(precision, {
      mode: 'vector',
      vector: { field: VECTOR_FIELD, value: queryVectors[row], metric: 'cosine', efSearch: PUBLISHED_EF_SEARCH },
      limit: RESULT_COUNT,
      document: false,
    })
  }
}

describe('search DBpedia 100K with every second document removed and not compacted, through the C search core', () => {
  afterAll(async () => {
    await narsil.shutdown()
  })

  bench('vector search at full precision, efSearch 128', () => vectorSearches('full-precision'))

  bench('vector search with 4-bit quantisation, efSearch 128', () => vectorSearches('osq4'))
})
