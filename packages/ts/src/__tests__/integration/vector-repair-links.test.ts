import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { setNativeSearchCoreEnabled } from '../../vector/native/backend'
import {
  DIMENSION,
  FIELD,
  NARROW_LIMIT,
  type Passage,
  passagesArrivingFileByFile,
  untilSettled,
  vectorHits,
} from './passages-by-file'
import { backends, searchWithTheHostBinary } from './removed-vectors/fixtures'
import { walkSavedGraph } from './saved-graph-walk'

const INDEX = 'passages'
const PASSAGES_IN_ONE_BUILD = 3_800
const EF_SEARCH = 100
const TEST_TIMEOUT_MS = 300_000

interface Build {
  baseLists: Map<string, string[]>
  notFirst: string[]
}

const engines: Narsil[] = []

function exactNearestByScan(passages: Passage[]): string[] {
  const dimension = DIMENSION
  const count = passages.length
  const unit = new Float64Array(count * dimension)
  for (let row = 0; row < count; row++) {
    const embedding = passages[row].embedding
    let squares = 0
    for (let d = 0; d < dimension; d++) squares += embedding[d] * embedding[d]
    const length = Math.sqrt(squares)
    for (let d = 0; d < dimension; d++) unit[row * dimension + d] = embedding[d] / length
  }
  const nearest: string[] = []
  for (let row = 0; row < count; row++) {
    let best = -1
    let bestScore = Number.NEGATIVE_INFINITY
    for (let other = 0; other < count; other++) {
      let dot = 0
      for (let d = 0; d < dimension; d++) dot += unit[row * dimension + d] * unit[other * dimension + d]
      if (dot > bestScore) {
        best = other
        bestScore = dot
      }
    }
    nearest.push(passages[best].id)
  }
  return nearest
}

async function builtOnce(passages: Passage[], exactNearest: string[]): Promise<Build> {
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  await engine.createIndex(INDEX, {
    schema: { [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: { threshold: passages.length, quantization: 'osq4' },
  })
  await engine.insertBatch(INDEX, passages)
  await untilSettled(engine, INDEX)
  const notFirst: string[] = []
  for (const [position, passage] of passages.entries()) {
    const [first] = await vectorHits(engine, INDEX, passage.embedding, NARROW_LIMIT, EF_SEARCH)
    if (first !== exactNearest[position]) notFirst.push(passage.id)
  }
  const walk = await walkSavedGraph(await engine.snapshot(INDEX), INDEX, FIELD)
  return { baseLists: walk.baseListOf, notFirst }
}

searchWithTheHostBinary()

describe('one build of passages that arrive in tight files', () => {
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown()
    setNativeSearchCoreEnabled(true)
  })

  it(
    'returns the exact nearest passage first for every passage, and both search cores link every passage the same way',
    async () => {
      const passages = passagesArrivingFileByFile(PASSAGES_IN_ONE_BUILD)
      const exactNearest = exactNearestByScan(passages)
      const builds: Array<{ name: string; build: Build }> = []
      for (const backend of backends) {
        if (!backend.available) continue
        setNativeSearchCoreEnabled(backend.native)
        builds.push({ name: backend.name, build: await builtOnce(passages, exactNearest) })
      }

      for (const { name, build } of builds) expect({ name, notFirst: build.notFirst }).toEqual({ name, notFirst: [] })
      const [first, ...others] = builds
      for (const other of others) expect(other.build.baseLists).toEqual(first.build.baseLists)
    },
    TEST_TIMEOUT_MS,
  )
})
