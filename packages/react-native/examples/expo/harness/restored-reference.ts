import { createNarsil, type Narsil, type VectorMaintenanceResult } from '@delali/narsil'
import { corpus, HYBRID_DEPTH, HYBRID_EF_SEARCH, HYBRID_TERM, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import { exactNeighbours, type RankedHit, recallAt } from './oracle.ts'

const RESTORED_INDEX = 'searched'
const VECTOR_FIELD = 'embedding'

export interface RestoredReference {
  recallAt10: number
  vector: Array<{ query: number; hits: RankedHit[] }>
  hybrid: Array<{ query: number; hits: RankedHit[] }>
  statusBefore: VectorMaintenanceResult | null
  statusAfter: VectorMaintenanceResult | null
}

function ranked(hits: ReadonlyArray<{ id: string; score?: number }>): RankedHit[] {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

function fieldStatus(narsil: Narsil): VectorMaintenanceResult | null {
  return narsil.vectorMaintenanceStatus(RESTORED_INDEX).find(field => field.fieldName === VECTOR_FIELD) ?? null
}

export async function answersOnRestoredSnapshot(snapshot: Uint8Array): Promise<RestoredReference> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    await narsil.restore(RESTORED_INDEX, snapshot)
    const statusBefore = fieldStatus(narsil)
    const documents = corpus()
    const recall: number[] = []
    const vector: RestoredReference['vector'] = []
    const hybrid: RestoredReference['hybrid'] = []
    for (const [query, value] of queryVectors().entries()) {
      const config = { field: VECTOR_FIELD, value, efSearch: HYBRID_EF_SEARCH }
      const top = await narsil.query(RESTORED_INDEX, { mode: 'vector', vector: config, limit: NEIGHBOURS })
      vector.push({ query, hits: ranked(top.hits) })
      recall.push(recallAt(ranked(top.hits), exactNeighbours(documents, value, NEIGHBOURS)))
      const fused = await narsil.query(RESTORED_INDEX, {
        mode: 'hybrid',
        term: HYBRID_TERM,
        vector: config,
        hybrid: { depth: HYBRID_DEPTH },
        limit: HYBRID_DEPTH,
      })
      hybrid.push({ query, hits: ranked(fused.hits) })
    }
    const recallAt10 = recall.reduce((sum, value) => sum + value, 0) / Math.max(1, recall.length)
    return { recallAt10, vector, hybrid, statusBefore, statusAfter: fieldStatus(narsil) }
  } finally {
    await narsil.shutdown()
  }
}
