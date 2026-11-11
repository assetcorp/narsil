import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { addBackgroundAdmission } from '../../runtime/background-memory'
import { waitFor } from '../server/helpers'

const DIMENSION = 8
const SETTLED_PASSAGES = 600
const ARRIVING_PASSAGES = 300
const SETTLED_PROBES = 100
const PROMOTION_THRESHOLD = 100
const GRAPH_DEGREE = 16
const PLACEMENT_DEPTH = 200
const EXHAUSTIVE_EF_SEARCH = 10_000
const NEAREST = 3
const DISTANCE_TIE = 1e-6
const SETTLE_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 120_000
const INDEX = 'passages'
const FIELD = 'embedding'

type Passage = {
  id: string
  title: string
  embedding: number[]
}

function passagesFrom(first: number, count: number): Passage[] {
  let state = (first + 7_919) >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  return Array.from({ length: count }, (_, i) => ({
    id: `passage-${first + i}`,
    title: `passage ${first + i}`,
    embedding: Array.from({ length: DIMENSION }, () => Math.fround(next() * 2 - 1)),
  }))
}

function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

function nearestDistances(acknowledged: ReadonlyMap<string, number[]>, query: readonly number[]): number[] {
  return [...acknowledged.values()]
    .map(vector => euclidean(query, vector))
    .sort((a, b) => a - b)
    .slice(0, NEAREST)
}

async function answersMissingFromAnExactScan(
  engine: Narsil,
  acknowledged: ReadonlyMap<string, number[]>,
  probes: readonly Passage[],
): Promise<string[]> {
  const missed: string[] = []
  for (const probe of probes) {
    const result = await engine.query(INDEX, {
      vector: { field: FIELD, value: probe.embedding, metric: 'euclidean', efSearch: EXHAUSTIVE_EF_SEARCH },
      limit: NEAREST,
    })
    const answered = result.hits.map(hit => {
      const vector = acknowledged.get(hit.id)
      return vector === undefined ? Number.POSITIVE_INFINITY : euclidean(probe.embedding, vector)
    })
    const expected = nearestDistances(acknowledged, probe.embedding)
    const matches =
      answered.length === expected.length &&
      answered.every((distance, at) => Math.abs(distance - expected[at]) <= DISTANCE_TIE)
    if (!matches) missed.push(probe.id)
  }
  return missed
}

function fieldStatus(engine: Narsil) {
  const [field] = engine.vectorMaintenanceStatus(INDEX)
  if (field === undefined) throw new Error('The index lost its vector field')
  return field
}

async function openSettledPassages(engine: Narsil): Promise<Passage[]> {
  await engine.createIndex(INDEX, {
    schema: { title: 'string', [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: {
      threshold: PROMOTION_THRESHOLD,
      quantization: 'none',
      hnswConfig: { m: GRAPH_DEGREE, efConstruction: PLACEMENT_DEPTH, metric: 'euclidean' },
    },
  })
  const settled = passagesFrom(0, SETTLED_PASSAGES)
  expect((await engine.insertBatch(INDEX, settled)).failed).toEqual([])
  await waitFor(async () => {
    const field = fieldStatus(engine)
    return field.graphCount === 1 && field.bufferSize === 0 && !field.building
  }, SETTLE_TIMEOUT_MS)
  return settled
}

describe('a growth pass on a node whose memory gate refuses a second graph', () => {
  it(
    'places a vector that an optimise call left waiting below the promotion threshold once the gate admits the copy',
    async () => {
      const engine = await createNarsil({ workers: { enabled: false } })
      let refusing = true
      const stopAdmitting = addBackgroundAdmission(() => !refusing)
      try {
        const settled = await openSettledPassages(engine)
        const acknowledged = new Map(settled.map(passage => [passage.id, passage.embedding]))
        const [late] = passagesFrom(SETTLED_PASSAGES, 1)
        expect((await engine.insertBatch(INDEX, [late])).failed).toEqual([])
        acknowledged.set(late.id, late.embedding)

        await engine.optimizeVectors(INDEX, FIELD)
        const waiting = fieldStatus(engine)
        expect(waiting.waitingForMemory).toBe(true)
        expect(waiting.bufferSize).toBe(1)
        expect(await answersMissingFromAnExactScan(engine, acknowledged, [late])).toEqual([])

        refusing = false
        await waitFor(async () => {
          const field = fieldStatus(engine)
          return !field.waitingForMemory && !field.building
        }, SETTLE_TIMEOUT_MS)
        expect(fieldStatus(engine).bufferSize).toBe(0)
        expect(await answersMissingFromAnExactScan(engine, acknowledged, [late])).toEqual([])
      } finally {
        stopAdmitting()
        await engine.shutdown()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'keeps arriving vectors in the buffer, answers exactly while they wait, and places them once the gate admits the copy',
    async () => {
      const engine = await createNarsil({ workers: { enabled: false } })
      const requestedBytes: number[] = []
      let refusing = true
      const stopAdmitting = addBackgroundAdmission(bytes => {
        requestedBytes.push(bytes)
        return !refusing
      })
      try {
        const settled = await openSettledPassages(engine)

        const acknowledged = new Map(settled.map(passage => [passage.id, passage.embedding]))
        const arriving = passagesFrom(SETTLED_PASSAGES, ARRIVING_PASSAGES)
        const probes = [...arriving, ...settled.slice(0, SETTLED_PROBES)]
        expect((await engine.insertBatch(INDEX, arriving)).failed).toEqual([])
        for (const passage of arriving) acknowledged.set(passage.id, passage.embedding)

        await waitFor(async () => {
          const field = fieldStatus(engine)
          return !field.building && (field.waitingForMemory || field.bufferSize === 0)
        }, SETTLE_TIMEOUT_MS)
        const waiting = fieldStatus(engine)
        expect(waiting.waitingForMemory).toBe(true)
        expect(waiting.bufferSize).toBe(ARRIVING_PASSAGES)
        expect(requestedBytes.some(bytes => bytes > 0)).toBe(true)
        expect(await answersMissingFromAnExactScan(engine, acknowledged, probes)).toEqual([])

        refusing = false
        await waitFor(async () => {
          const field = fieldStatus(engine)
          return field.bufferSize === 0 && !field.waitingForMemory && !field.building
        }, SETTLE_TIMEOUT_MS)
        expect(await answersMissingFromAnExactScan(engine, acknowledged, probes)).toEqual([])
      } finally {
        stopAdmitting()
        await engine.shutdown()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
