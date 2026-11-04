import { createNarsil, type Narsil } from '@delali/narsil'
import { corpus, DIMENSION, HYBRID_EF_SEARCH, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import { exactNeighbours, recallAt } from './oracle.ts'

const BUILT_INDEX = 'built-on-node'
const VECTOR_FIELD = 'embedding'
const SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const
const GRAPH_SETTLE_TIMEOUT_MS = 120_000
const GRAPH_SETTLE_POLL_MS = 50

async function graphSettled(narsil: Narsil): Promise<void> {
  const deadline = performance.now() + GRAPH_SETTLE_TIMEOUT_MS
  for (;;) {
    const field = narsil.vectorMaintenanceStatus(BUILT_INDEX).find(status => status.fieldName === VECTOR_FIELD)
    const settled =
      field !== undefined &&
      field.graphCount === 1 &&
      field.bufferSize === 0 &&
      !field.building &&
      !field.waitingForMemory &&
      !field.loadingFromFiles
    if (settled) return
    if (performance.now() > deadline)
      throw new Error(`The Node.js vector graph did not settle: ${JSON.stringify(field)}`)
    await new Promise(resolve => setTimeout(resolve, GRAPH_SETTLE_POLL_MS))
  }
}

export async function recallOfAnIndexNodeBuilds(): Promise<number> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    const documents = corpus()
    await narsil.createIndex(BUILT_INDEX, { schema: SCHEMA, language: 'english' })
    const inserted = await narsil.insertBatch(BUILT_INDEX, documents)
    if (inserted.failed.length > 0) throw new Error(`${inserted.failed.length} documents failed to insert on Node.js`)
    await graphSettled(narsil)
    const recall: number[] = []
    for (const value of queryVectors()) {
      const answer = await narsil.query(BUILT_INDEX, {
        mode: 'vector',
        vector: { field: VECTOR_FIELD, value, efSearch: HYBRID_EF_SEARCH },
        limit: NEIGHBOURS,
      })
      const hits = answer.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
      recall.push(recallAt(hits, exactNeighbours(documents, value, NEIGHBOURS)))
    }
    return recall.reduce((sum, value) => sum + value, 0) / Math.max(1, recall.length)
  } finally {
    await narsil.shutdown()
  }
}
