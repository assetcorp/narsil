import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { waitFor } from '../server/helpers'
import {
  DIMENSION,
  exactCosineRanking,
  FIELD,
  insertFileByFile,
  NARROW_EF_SEARCH,
  NARROW_LIMIT,
  type Passage,
  passagesArrivingFileByFile,
  passagesNotFoundFirst,
  questionsNear,
  SETTLE_TIMEOUT_MS,
  savedCounts,
  snapshotFromAnEarlierRelease,
  snapshotWithFarPairs,
  untilSettled,
  vectorHits,
  WIDE_EF_SEARCH,
  WIDE_LIMIT,
} from './passages-by-file'
import { walkSavedGraph } from './saved-graph-walk'

const ARRIVING_PASSAGES = 6_000
const SAVED_PASSAGES = 2_000
const QUESTIONS = 40
const RECALL_FLOOR = 0.95
const ARRIVAL_TIMEOUT_MS = 600_000
const INDEX = 'passages'

async function restoredCopy(engine: Narsil, from: string, into: string): Promise<void> {
  await engine.restore(into, new Uint8Array(await new Response(await engine.snapshot(from)).arrayBuffer()))
  await untilSettled(engine, into)
}

describe('vector search over passages that arrive file by file', () => {
  let engine: Narsil
  const passages = passagesArrivingFileByFile(ARRIVING_PASSAGES)

  beforeAll(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    await engine.createIndex(INDEX, {
      schema: { [FIELD]: `vector[${DIMENSION}]` },
      vectorPromotion: { quantization: 'osq4' },
    })
    await insertFileByFile(engine, INDEX, passages)
  }, ARRIVAL_TIMEOUT_MS)

  afterAll(async () => {
    await engine.shutdown()
  })

  it(
    'returns every stored passage first for its own vector at a narrow and a wide limit',
    async () => {
      expect(await passagesNotFoundFirst(engine, INDEX, passages, NARROW_LIMIT, NARROW_EF_SEARCH)).toEqual([])
      expect(await passagesNotFoundFirst(engine, INDEX, passages, WIDE_LIMIT, WIDE_EF_SEARCH)).toEqual([])
    },
    ARRIVAL_TIMEOUT_MS,
  )

  it(
    'answers questions with the exact nearest passage first and recall at or above the floor',
    async () => {
      for (const [limit, efSearch] of [
        [NARROW_LIMIT, NARROW_EF_SEARCH],
        [WIDE_LIMIT, WIDE_EF_SEARCH],
      ]) {
        let found = 0
        const firstMissed: number[] = []
        for (const [position, question] of questionsNear(passages, QUESTIONS).entries()) {
          const exact = exactCosineRanking(passages, question)
          const hits = await vectorHits(engine, INDEX, question, limit, efSearch)
          const nearest = new Set(exact.slice(0, limit).map(entry => entry.id))
          found += hits.filter(id => nearest.has(id)).length
          if (hits[0] !== exact[0].id) firstMissed.push(position)
        }
        expect({ limit, firstMissed }).toEqual({ limit, firstMissed: [] })
        expect(found / (QUESTIONS * limit)).toBeGreaterThanOrEqual(RECALL_FLOOR)
      }
    },
    ARRIVAL_TIMEOUT_MS,
  )
})

describe('a saved graph and the count of its last shuffled build', () => {
  let engine: Narsil
  let passages: Passage[]

  beforeEach(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    passages = passagesArrivingFileByFile(SAVED_PASSAGES)
    await engine.createIndex(INDEX, {
      schema: { [FIELD]: `vector[${DIMENSION}]` },
      vectorPromotion: { quantization: 'osq4', threshold: SAVED_PASSAGES },
    })
    await insertFileByFile(engine, INDEX, passages)
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('records the node count of the build and keeps it through a save and a load', async () => {
    expect(await savedCounts(engine, INDEX)).toEqual([SAVED_PASSAGES])

    await restoredCopy(engine, INDEX, 'copy')

    expect(await savedCounts(engine, 'copy')).toEqual([SAVED_PASSAGES])
  })

  it('rebuilds a loaded graph that carries no count, and the next save carries one', async () => {
    const fromAnEarlierRelease = await snapshotFromAnEarlierRelease(engine, INDEX, SAVED_PASSAGES)
    const saved = await walkSavedGraph(new Blob([fromAnEarlierRelease]).stream(), INDEX, FIELD)

    await engine.restore('earlier', fromAnEarlierRelease)
    await waitFor(async () => (await savedCounts(engine, 'earlier'))[0] === SAVED_PASSAGES, SETTLE_TIMEOUT_MS)
    await untilSettled(engine, 'earlier')

    const rebuilt = await walkSavedGraph(await engine.snapshot('earlier'), 'earlier', FIELD)
    const unchangedLists = [...rebuilt.baseListOf].filter(
      ([docId, list]) => JSON.stringify(list) === JSON.stringify(saved.baseListOf.get(docId)),
    )
    expect(unchangedLists.length).toBeLessThan(SAVED_PASSAGES / 10)
    expect(await passagesNotFoundFirst(engine, 'earlier', passages, NARROW_LIMIT, NARROW_EF_SEARCH)).toEqual([])
  })

  it('leaves a loaded graph that carries a count as it was saved', async () => {
    const damaged = await snapshotWithFarPairs(engine, INDEX, SAVED_PASSAGES)
    const saved = await walkSavedGraph(new Blob([damaged]).stream(), INDEX, FIELD)

    await engine.restore('current', damaged)
    await untilSettled(engine, 'current')
    await vectorHits(engine, 'current', passages[0].embedding, NARROW_LIMIT, NARROW_EF_SEARCH)
    await untilSettled(engine, 'current')

    const loaded = await walkSavedGraph(await engine.snapshot('current'), 'current', FIELD)
    expect(loaded.baseListOf).toEqual(saved.baseListOf)
    expect(await savedCounts(engine, 'current')).toEqual([SAVED_PASSAGES])
    const missed = await passagesNotFoundFirst(engine, 'current', passages, NARROW_LIMIT, NARROW_EF_SEARCH)
    expect(missed.length).toBeGreaterThan(0)
  })

  it('rebuilds a loaded graph once it holds twice the nodes of its saved count', async () => {
    await restoredCopy(engine, INDEX, 'grown')
    const later = passagesArrivingFileByFile(2 * SAVED_PASSAGES).slice(SAVED_PASSAGES)

    await insertFileByFile(engine, 'grown', later.slice(0, SAVED_PASSAGES / 2))
    expect(await savedCounts(engine, 'grown')).toEqual([SAVED_PASSAGES])

    await insertFileByFile(engine, 'grown', later.slice(SAVED_PASSAGES / 2))
    expect(await savedCounts(engine, 'grown')).toEqual([2 * SAVED_PASSAGES])
  })
})
