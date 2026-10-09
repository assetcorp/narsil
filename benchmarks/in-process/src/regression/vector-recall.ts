import { DBPEDIA_DOCUMENTS, dbpediaDirectory, loadNearestNeighbours, loadQueries, vectorOf } from './dbpedia/dataset'
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
import type { QualityCheckDefinition } from './quality-check'

const ALL_QUERIES = Number.MAX_SAFE_INTEGER

export const VECTOR_RECALL: QualityCheckDefinition = {
  check: 'vector-recall',
  title: 'Vector recall on DBpedia 100K',
  subjects: VECTOR_PRECISIONS,
  metrics: [{ key: 'recall10', label: 'Recall@10 at efSearch 128' }],
}

function isPrecision(subject: string): subject is VectorPrecision {
  return (VECTOR_PRECISIONS as readonly string[]).includes(subject)
}

export async function measureVectorRecall(subject: string): Promise<Record<string, number>> {
  if (!isPrecision(subject)) throw new Error(`no DBpedia index holds the precision ${subject}`)
  const dataset = dbpediaDirectory()
  const queries = loadQueries(dataset, ALL_QUERIES)
  const truth = loadNearestNeighbours(dataset)
  const narsil = await createSingleThreadEngine()
  try {
    await restoreIndex(narsil, indexDirectory(), subject)
    const documents = narsil.getStats(subject).documentCount
    if (documents !== DBPEDIA_DOCUMENTS) {
      throw new Error(`the ${subject} index holds ${documents} documents, and recall needs all ${DBPEDIA_DOCUMENTS}`)
    }
    let found = 0
    let expected = 0
    for (let row = 0; row < queries.ids.length; row++) {
      const neighbours = truth.get(queries.ids[row])
      if (neighbours === undefined)
        throw new Error(`the ground truth holds no neighbours for query ${queries.ids[row]}`)
      const result = await narsil.query(subject, {
        mode: 'vector',
        vector: { field: VECTOR_FIELD, value: vectorOf(queries, row), metric: 'cosine', efSearch: PUBLISHED_EF_SEARCH },
        limit: RESULT_COUNT,
        document: false,
      })
      const nearest = new Set(neighbours.slice(0, RESULT_COUNT))
      found += result.hits.filter(hit => nearest.has(hit.id)).length
      expected += nearest.size
    }
    console.log(`${subject}: ${queries.ids.length} queries over ${documents} documents`)
    return { recall10: expected === 0 ? 0 : found / expected }
  } finally {
    await narsil.shutdown()
  }
}
