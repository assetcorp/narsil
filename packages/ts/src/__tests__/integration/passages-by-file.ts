import type { Narsil } from '../../narsil'
import { waitFor } from '../server/helpers'
import { snapshotWithBaseLists, snapshotWithoutShuffledBuildCount } from './saved-graph-edit'
import { savedBuildHistories } from './saved-graph-walk'

export const DIMENSION = 384
export const PASSAGES_PER_FILE = 100
export const NARROW_LIMIT = 10
export const NARROW_EF_SEARCH = 500
export const WIDE_LIMIT = 200
export const WIDE_EF_SEARCH = 1_000
export const SETTLE_TIMEOUT_MS = 120_000
export const FIELD = 'embedding'

const SHARED_DIRECTION_SHARE = 0.76
const FILE_DIRECTION_SHARE = 0.23
const PASSAGE_NOISE_SHARE = 0.01
const TOPICS = 3
const TOPIC_SHARE_OF_A_FILE = 0.9
const QUESTION_PASSAGE_WEIGHT = 0.8
const QUESTION_NOISE_WEIGHT = 0.6
const FIXTURE_SEED = 1
const QUESTION_SEED = 1_000_003

export type Passage = {
  id: string
  embedding: number[]
}

function generatorOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function unitVector(uniform: () => number): number[] {
  const values = Array.from({ length: DIMENSION }, () => {
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12)))
    return radius * Math.cos(2 * Math.PI * uniform())
  })
  const length = Math.hypot(...values)
  return values.map(value => value / length)
}

export function passagesArrivingFileByFile(count: number): Passage[] {
  const uniform = generatorOf(FIXTURE_SEED)
  const shared = unitVector(uniform)
  const topics = Array.from({ length: TOPICS }, () => unitVector(uniform))
  const topicWeight = Math.sqrt(TOPIC_SHARE_OF_A_FILE)
  const ownWeight = Math.sqrt(1 - TOPIC_SHARE_OF_A_FILE)
  const passages: Passage[] = []
  let file: number[] = []
  for (let i = 0; i < count; i++) {
    if (i % PASSAGES_PER_FILE === 0) {
      const topic = topics[Math.floor(uniform() * TOPICS)]
      const own = unitVector(uniform)
      file = own.map((value, d) => topicWeight * topic[d] + ownWeight * value)
    }
    const noise = unitVector(uniform)
    passages.push({
      id: `passage-${String(i).padStart(5, '0')}`,
      embedding: shared.map(
        (value, d) =>
          Math.sqrt(SHARED_DIRECTION_SHARE) * value +
          Math.sqrt(FILE_DIRECTION_SHARE) * file[d] +
          Math.sqrt(PASSAGE_NOISE_SHARE) * noise[d],
      ),
    })
  }
  return passages
}

export function questionsNear(passages: Passage[], count: number): number[][] {
  const uniform = generatorOf(QUESTION_SEED)
  return Array.from({ length: count }, () => {
    const passage = passages[Math.floor(uniform() * passages.length)]
    const noise = unitVector(uniform)
    return passage.embedding.map((value, d) => QUESTION_PASSAGE_WEIGHT * value + QUESTION_NOISE_WEIGHT * noise[d])
  })
}

export function exactCosineRanking(passages: Passage[], question: number[]): Array<{ id: string; score: number }> {
  const questionLength = Math.hypot(...question)
  return passages
    .map(passage => {
      let dot = 0
      for (let d = 0; d < DIMENSION; d++) dot += passage.embedding[d] * question[d]
      return { id: passage.id, score: dot / (Math.hypot(...passage.embedding) * questionLength) }
    })
    .sort((a, b) => b.score - a.score)
}

export async function vectorHits(
  engine: Narsil,
  index: string,
  value: number[],
  limit: number,
  efSearch: number,
): Promise<string[]> {
  const result = await engine.query(index, {
    mode: 'vector',
    vector: { field: FIELD, value, efSearch },
    limit,
    document: false,
  })
  return result.hits.map(hit => hit.id)
}

export async function passagesNotFoundFirst(
  engine: Narsil,
  index: string,
  passages: Passage[],
  limit: number,
  efSearch: number,
): Promise<string[]> {
  const missed: string[] = []
  for (const passage of passages) {
    const [first] = await vectorHits(engine, index, passage.embedding, limit, efSearch)
    if (first !== passage.id) missed.push(passage.id)
  }
  return missed
}

export async function untilSettled(engine: Narsil, index: string): Promise<void> {
  await waitFor(async () => {
    const [field] = engine.vectorMaintenanceStatus(index)
    return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
  }, SETTLE_TIMEOUT_MS)
}

export async function insertFileByFile(engine: Narsil, index: string, passages: Passage[]): Promise<void> {
  for (let start = 0; start < passages.length; start += PASSAGES_PER_FILE) {
    await engine.insertBatch(index, passages.slice(start, start + PASSAGES_PER_FILE))
  }
  await engine.optimizeVectors(index, FIELD)
  await untilSettled(engine, index)
}

export async function insertFileByFileWithoutOptimizing(
  engine: Narsil,
  index: string,
  passages: Passage[],
): Promise<void> {
  for (let start = 0; start < passages.length; start += PASSAGES_PER_FILE) {
    await engine.insertBatch(index, passages.slice(start, start + PASSAGES_PER_FILE))
  }
  await waitFor(async () => {
    const [field] = engine.vectorMaintenanceStatus(index)
    return field !== undefined && field.graphCount === 1 && !field.building
  }, SETTLE_TIMEOUT_MS)
}

export async function savedCounts(engine: Narsil, index: string): Promise<Array<number | null>> {
  const histories = await savedBuildHistories(await engine.snapshot(index), index, FIELD)
  return histories.map(history => history.shuffledBuildCount)
}

export async function savedMeanLengths(engine: Narsil, index: string): Promise<Array<number | null>> {
  const histories = await savedBuildHistories(await engine.snapshot(index), index, FIELD)
  return histories.map(history => history.calibratedMeanLength)
}

export function lengthOfTheMeanUnitVector(passages: Passage[]): number {
  const sums = new Array<number>(DIMENSION).fill(0)
  for (const passage of passages) {
    const length = Math.hypot(...passage.embedding)
    for (let d = 0; d < DIMENSION; d++) sums[d] += passage.embedding[d] / length
  }
  return Math.hypot(...sums) / passages.length
}

export function shuffledBySeed<T>(items: T[], seed: number): T[] {
  const uniform = generatorOf(seed)
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(uniform() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export async function snapshotWithFarPairs(
  engine: Narsil,
  index: string,
  count: number,
): Promise<Uint8Array<ArrayBuffer>> {
  return snapshotWithBaseLists(await engine.snapshot(index), FIELD, () => ({
    entryPoint: 0,
    baseListOf: (number: number) => [(number + count / 2) % count],
  }))
}

export async function snapshotFromAnEarlierRelease(
  engine: Narsil,
  index: string,
  count: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const damaged = await snapshotWithFarPairs(engine, index, count)
  return snapshotWithoutShuffledBuildCount(new Blob([damaged]).stream(), FIELD)
}
