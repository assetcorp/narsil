import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { waitFor } from '../server/helpers'
import {
  DIMENSION,
  exactCosineRanking,
  FIELD,
  insertFileByFile,
  insertFileByFileWithoutOptimizing,
  NARROW_EF_SEARCH,
  NARROW_LIMIT,
  type Passage,
  passagesArrivingFileByFile,
  passagesNotFoundFirst,
  questionsNear,
  SETTLE_TIMEOUT_MS,
  snapshotFromAnEarlierRelease,
  untilSettled,
  vectorHits,
  WIDE_EF_SEARCH,
  WIDE_LIMIT,
} from './passages-by-file'
import { snapshotWithMeanLength } from './saved-graph-edit'

const ARRIVING_PASSAGES = 6_000
const SAVED_PASSAGES = 2_000
const PROBE_PASSAGES = 50
const QUESTIONS = 40
const RECALL_FLOOR = 0.95
const ARRIVAL_TIMEOUT_MS = 600_000
const INDEX = 'passages'

describe('vector search over passages that arrive file by file', () => {
  let engine: Narsil
  const passages = passagesArrivingFileByFile(ARRIVING_PASSAGES)

  beforeAll(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    await engine.createIndex(INDEX, {
      schema: { [FIELD]: `vector[${DIMENSION}]` },
      vectorPromotion: { quantization: 'osq4' },
    })
    await insertFileByFileWithoutOptimizing(engine, INDEX, passages)
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

describe('a saved graph that this release loads', { timeout: ARRIVAL_TIMEOUT_MS }, () => {
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
  }, ARRIVAL_TIMEOUT_MS)

  afterEach(async () => {
    await engine.shutdown()
  })

  it('finds every stored passage first after a load from an earlier release and after files arrive past a doubling', async () => {
    await engine.restore('earlier', await snapshotFromAnEarlierRelease(engine, INDEX, SAVED_PASSAGES))
    const probe = passages.slice(0, PROBE_PASSAGES)
    await waitFor(
      async () => (await passagesNotFoundFirst(engine, 'earlier', probe, NARROW_LIMIT, NARROW_EF_SEARCH)).length === 0,
      SETTLE_TIMEOUT_MS,
    )
    await untilSettled(engine, 'earlier')
    expect(await passagesNotFoundFirst(engine, 'earlier', passages, NARROW_LIMIT, NARROW_EF_SEARCH)).toEqual([])

    const grown = passagesArrivingFileByFile(2 * SAVED_PASSAGES)
    await insertFileByFile(engine, 'earlier', grown.slice(SAVED_PASSAGES))
    expect(await passagesNotFoundFirst(engine, 'earlier', grown, NARROW_LIMIT, NARROW_EF_SEARCH)).toEqual([])
  })

  it.each([
    { keepsShuffledBuildCount: true, calibratedMeanLength: -0.5 },
    { keepsShuffledBuildCount: false, calibratedMeanLength: -0.5 },
  ])('refuses a saved mean length of $calibratedMeanLength when the count is kept: $keepsShuffledBuildCount', async ({
    keepsShuffledBuildCount,
    calibratedMeanLength,
  }) => {
    const damaged = await snapshotWithMeanLength(
      await engine.snapshot(INDEX),
      FIELD,
      calibratedMeanLength,
      keepsShuffledBuildCount,
    )
    await expect(engine.restore('damaged', damaged)).rejects.toMatchObject({ code: 'PERSISTENCE_LOAD_FAILED' })
  })
})
