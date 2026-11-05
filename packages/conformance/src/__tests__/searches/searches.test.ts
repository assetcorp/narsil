import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../../ts/src/types/engine'
import { fetchPinnedDataset } from '../../dataset/fetch'
import { type ConformanceDataset, loadDataset } from '../../dataset/load'
import { readPin } from '../../dataset/pin'
import { type CosineScan, cosineScan, recallAgainst } from '../../independent/neighbours'
import {
  EXACT_NEIGHBOURS,
  RECALL_FLOORS,
  SCORE_RELATIVE_TOLERANCE,
  SIMILARITY_TOLERANCE,
  TEXT_RESULT_LIMIT,
} from '../../searches/constants'
import { type ExpectedSearches, readExpectedSearches } from '../../searches/expected'
import { openReferenceIndex, textHits, vectorHitIds } from '../../searches/reference-index'

const SETUP_TIMEOUT_MS = 900_000

let expected: ExpectedSearches
let dataset: ConformanceDataset
let scan: CosineScan
let reference: Narsil | undefined

function referenceIndex(): Narsil {
  if (reference === undefined) throw new Error('the reference index failed to open')
  return reference
}

function closeTo(actual: number, wanted: number): boolean {
  return Math.abs(actual - wanted) <= SCORE_RELATIVE_TOLERANCE * Math.max(1, Math.abs(wanted))
}

beforeAll(async () => {
  expected = await readExpectedSearches()
  dataset = await loadDataset(await fetchPinnedDataset())
  scan = cosineScan(dataset.vectors)
  reference = await openReferenceIndex(dataset)
}, SETUP_TIMEOUT_MS)

afterAll(async () => {
  await reference?.shutdown()
})

describe('the committed searches over the pinned dataset', () => {
  it('pin the dataset that the suite fetches and cover every query in it', async () => {
    expect(expected.dataset).toEqual(await readPin())
    expect(expected.vector.floors).toEqual(RECALL_FLOORS)
    expect(expected.text.queries.map(query => [query.id, query.text])).toEqual(
      dataset.queries.textQueries.map(query => [query.id, query.text]),
    )
    expect(expected.vector.queries.map(query => [query.id, query.text])).toEqual(
      dataset.queries.vectorQueries.map(query => [query.id, query.text]),
    )
  })

  it('list exactly the nearest neighbours that a brute-force cosine scan finds', () => {
    dataset.queries.vectorQueries.forEach((query, at) => {
      const committed = expected.vector.queries[at].neighbours
      expect(committed).toHaveLength(EXACT_NEIGHBOURS)
      expect(new Set(committed.map(neighbour => neighbour.id)).size).toBe(EXACT_NEIGHBOURS)
      const similarities = scan.similaritiesTo(query.vector)
      for (const neighbour of committed) {
        expect(Math.abs(similarities[scan.rowOf(neighbour.id)] - neighbour.similarity)).toBeLessThanOrEqual(
          SIMILARITY_TOLERANCE,
        )
      }
      const cutoff = committed[EXACT_NEIGHBOURS - 1].similarity + SIMILARITY_TOLERANCE
      committed.slice(1).forEach((neighbour, at) => {
        expect(neighbour.similarity).toBeLessThanOrEqual(committed[at].similarity)
      })
      const listed = new Set(committed.map(neighbour => neighbour.id))
      const missing = dataset.vectors.ids.filter((id, row) => similarities[row] > cutoff && !listed.has(id))
      expect(missing, `query ${query.id}`).toEqual([])
    })
  })
})

describe('the reference over the pinned dataset', () => {
  it('returns the committed text results in the committed order', async () => {
    for (const query of expected.text.queries) {
      const hits = await textHits(referenceIndex(), query.text, TEXT_RESULT_LIMIT)
      expect(
        hits.map(hit => hit.id),
        `query ${query.id}`,
      ).toEqual(query.hits.map(hit => hit.id))
      hits.forEach((hit, rank) => {
        expect(closeTo(hit.score, query.hits[rank].score), `query ${query.id} at rank ${rank + 1}`).toBe(true)
      })
    }
  })

  it.each(RECALL_FLOORS)('reaches recall@$k of at least $floor at the default search settings', async ({
    k,
    floor,
  }) => {
    let total = 0
    for (const [at, query] of dataset.queries.vectorQueries.entries()) {
      const similarities = scan.similaritiesTo(query.vector)
      const returned = await vectorHitIds(referenceIndex(), query.vector, k)
      total += recallAgainst(
        returned,
        expected.vector.queries[at].neighbours,
        k,
        id => similarities[scan.rowOf(id)],
        SIMILARITY_TOLERANCE,
      )
    }
    expect(total / dataset.queries.vectorQueries.length).toBeGreaterThanOrEqual(floor)
  })
})
