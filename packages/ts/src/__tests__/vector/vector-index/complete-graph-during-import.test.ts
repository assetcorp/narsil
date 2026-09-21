import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector } from './fixtures'

const FIRST_BATCH = 300
const WAITING_WHEN_THE_CALL_STARTS = 600
const ARRIVALS_PER_TURN = 200
const MOST_ARRIVALS = 20_000

function insertRange(index: VectorIndex, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }
}

function placedDocIds(index: VectorIndex): Set<string> {
  const placed = new Set<string>()
  const graph = index.serialize()[0]?.graphs[0]
  if (graph === undefined) return placed
  for (const [docId] of graph.nodes) placed.add(docId)
  return placed
}

describe('completing the graph while an import keeps adding vectors', () => {
  let index: VectorIndex

  beforeEach(() => {
    index = createVectorIndex('embedding', DIM, { threshold: FIRST_BATCH, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
  })

  it('places the vectors that the index held when the call started and leaves later arrivals to the next build', async () => {
    insertRange(index, 0, FIRST_BATCH)
    index.scheduleBuild()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await index.awaitPendingBuild()
    insertRange(index, FIRST_BATCH, WAITING_WHEN_THE_CALL_STARTS)

    let arrived = WAITING_WHEN_THE_CALL_STARTS
    let importing = true
    function importMore(): void {
      if (!importing || arrived >= MOST_ARRIVALS) return
      insertRange(index, arrived, arrived + ARRIVALS_PER_TURN)
      arrived += ARRIVALS_PER_TURN
      setTimeout(importMore, 0)
    }
    setTimeout(importMore, 0)

    await index.completeGraph()
    const arrivedWhenTheGraphWasComplete = arrived
    importing = false

    expect(arrivedWhenTheGraphWasComplete).toBeLessThan(MOST_ARRIVALS)
    const placed = placedDocIds(index)
    for (let i = 0; i < WAITING_WHEN_THE_CALL_STARTS; i++) {
      expect(placed.has(`doc${i}`)).toBe(true)
    }
  }, 60_000)
})
