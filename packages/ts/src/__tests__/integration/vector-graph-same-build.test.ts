import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { setNativeSearchCoreEnabled } from '../../vector/native/backend'
import {
  DIMENSION,
  exactCosineRanking,
  FIELD,
  insertFileByFile,
  NARROW_EF_SEARCH,
  NARROW_LIMIT,
  type Passage,
  passagesArrivingFileByFile,
  questionsNear,
  vectorHits,
} from './passages-by-file'
import { backends, searchWithTheHostBinary } from './removed-vectors/fixtures'
import { walkSavedGraph } from './saved-graph-walk'

const INDEX = 'passages'
const PASSAGES = 1_500
const QUESTIONS = 30
const BUILDS = 3
const SPEC_RECALL_AT_10 = 0.95
const TEST_TIMEOUT_MS = 300_000

interface Build {
  baseLists: Map<string, string[]>
  answers: string[][]
}

const engines: Narsil[] = []

async function builtFrom(passages: Passage[], questions: number[][]): Promise<Build> {
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  await engine.createIndex(INDEX, {
    schema: { [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: { threshold: 100, quantization: 'osq4' },
  })
  await insertFileByFile(engine, INDEX, passages)
  const walk = await walkSavedGraph(await engine.snapshot(INDEX), INDEX, FIELD)
  const answers: string[][] = []
  for (const question of questions) {
    answers.push(await vectorHits(engine, INDEX, question, NARROW_LIMIT, NARROW_EF_SEARCH))
  }
  return { baseLists: walk.baseListOf, answers }
}

function recallAgainstExactScan(passages: Passage[], questions: number[][], answers: string[][]): number {
  let found = 0
  questions.forEach((question, position) => {
    const exact = new Set(
      exactCosineRanking(passages, question)
        .slice(0, NARROW_LIMIT)
        .map(hit => hit.id),
    )
    found += answers[position].filter(id => exact.has(id)).length
  })
  return found / (questions.length * NARROW_LIMIT)
}

searchWithTheHostBinary()

describe.each(backends)('three builds of the same passages through $name', ({ native, available }) => {
  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown()
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!available)(
    'link every passage the same way and give every question the same answer at the recall the spec requires',
    async () => {
      const passages = passagesArrivingFileByFile(PASSAGES)
      const questions = questionsNear(passages, QUESTIONS)
      const builds: Build[] = []
      for (let build = 0; build < BUILDS; build++) builds.push(await builtFrom(passages, questions))

      const [first, ...others] = builds
      for (const other of others) {
        expect(other.baseLists).toEqual(first.baseLists)
        expect(other.answers).toEqual(first.answers)
      }
      expect(recallAgainstExactScan(passages, questions, first.answers)).toBeGreaterThanOrEqual(SPEC_RECALL_AT_10)
    },
    TEST_TIMEOUT_MS,
  )
})
