import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import { waitFor } from '../server/helpers'

const built = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))

const DIMENSION = 8
const CLUSTERS = 40
const CLUSTER_SPREAD = 0.02
const SETTLED_FRAMES = 2_000
const ARRIVING_FRAMES = 3_000
const ROUNDS = 2
const PROMOTION_THRESHOLD = 100
const GRAPH_DEGREE = 4
const PLACEMENT_DEPTH_ON_THE_MAIN_THREAD = 16
const PLACEMENT_DEPTH_ON_WORKER_THREADS = 32
const EXHAUSTIVE_EF_SEARCH = 10_000
const NEAREST = 3
const DISTANCE_TIE = 1e-6
const SCORE_TOLERANCE = 1e-5
const SEARCHES_BESIDE_A_PASS_AT_LEAST = 20
const PROBES_IN_FLIGHT = 4
const SETTLE_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 300_000
const INDEX = 'frames'
const FIELD = 'embedding'

type Frame = {
  id: string
  title: string
  embedding: number[]
}

interface OracleHit {
  id: string
  distance: number
}

interface MissedAnswer {
  probe: string
  expected: OracleHit[]
  answered: Array<{ id: string; score: number | undefined }>
}

interface SearchRecord {
  besideAPass: number
  missed: MissedAnswer[]
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function clusterCentres(): number[][] {
  const next = randomSource(7)
  return Array.from({ length: CLUSTERS }, () => Array.from({ length: DIMENSION }, () => next() * 2 - 1))
}

function framesFrom(centres: number[][], first: number, count: number): Frame[] {
  const next = randomSource(first + 1_000_003)
  return Array.from({ length: count }, (_, i) => {
    const centre = centres[(first + i) % CLUSTERS]
    return {
      id: `frame-${first + i}`,
      title: `frame ${first + i}`,
      embedding: centre.map(value => Math.fround(value + (next() * 2 - 1) * CLUSTER_SPREAD)),
    }
  })
}

function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const difference = a[i] - b[i]
    sum += difference * difference
  }
  return Math.sqrt(sum)
}

function oracleNearest(acknowledged: ReadonlyMap<string, number[]>, query: readonly number[]): OracleHit[] {
  const nearest: OracleHit[] = []
  for (const [id, vector] of acknowledged) {
    const distance = euclidean(query, vector)
    if (nearest.length === NEAREST && distance >= nearest[NEAREST - 1].distance) continue
    nearest.push({ id, distance })
    nearest.sort((a, b) => a.distance - b.distance)
    if (nearest.length > NEAREST) nearest.pop()
  }
  return nearest
}

function answerMatchesOracle(
  expected: OracleHit[],
  answered: ReadonlyArray<{ id: string; score: number | undefined }>,
  acknowledged: ReadonlyMap<string, number[]>,
  query: readonly number[],
): boolean {
  if (answered.length !== expected.length) return false
  for (let rank = 0; rank < expected.length; rank++) {
    const hit = answered[rank]
    const vector = acknowledged.get(hit.id)
    if (vector === undefined || hit.score === undefined) return false
    const distance = euclidean(query, vector)
    if (Math.abs(distance - expected[rank].distance) > DISTANCE_TIE) return false
    if (Math.abs(hit.score - 1 / (1 + distance)) > SCORE_TOLERANCE) return false
  }
  return new Set(answered.map(hit => hit.id)).size === answered.length
}

async function placementUnderWay(opened: Narsil): Promise<boolean> {
  const [field] = opened.vectorMaintenanceStatus(INDEX)
  return field !== undefined && (field.building || field.bufferSize > 0)
}

async function probe(
  opened: Narsil,
  acknowledged: ReadonlyMap<string, number[]>,
  id: string,
  record: SearchRecord,
): Promise<void> {
  const query = acknowledged.get(id)
  if (query === undefined) return
  const besideAPass = await placementUnderWay(opened)
  const result = await opened.query(INDEX, {
    vector: { field: FIELD, value: query, metric: 'euclidean', efSearch: EXHAUSTIVE_EF_SEARCH },
    limit: NEAREST,
  })
  if (besideAPass) record.besideAPass += 1
  const answered = result.hits.map(hit => ({ id: hit.id, score: hit.score }))
  const expected = oracleNearest(acknowledged, query)
  if (!answerMatchesOracle(expected, answered, acknowledged, query))
    record.missed.push({ probe: id, expected, answered })
}

async function openSettledFrames(config: NarsilConfig, centres: number[][], placementDepth: number): Promise<Narsil> {
  const opened = await createNarsil(config)
  await opened.createIndex(INDEX, {
    schema: { title: 'string', [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: {
      threshold: PROMOTION_THRESHOLD,
      quantization: 'none',
      hnswConfig: { m: GRAPH_DEGREE, efConstruction: placementDepth, metric: 'euclidean' },
    },
  })
  const settled = await opened.insertBatch(INDEX, framesFrom(centres, 0, SETTLED_FRAMES))
  expect(settled.failed).toEqual([])
  await waitFor(async () => {
    const [field] = opened.vectorMaintenanceStatus(INDEX)
    return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
  }, SETTLE_TIMEOUT_MS)
  return opened
}

async function searchEveryOlderVectorWhileArrivalsArePlaced(
  config: NarsilConfig,
  placementDepth: number,
): Promise<SearchRecord> {
  const centres = clusterCentres()
  const opened = await openSettledFrames(config, centres, placementDepth)
  const record: SearchRecord = { besideAPass: 0, missed: [] }
  const acknowledged = new Map<string, number[]>()
  for (const frame of framesFrom(centres, 0, SETTLED_FRAMES)) acknowledged.set(frame.id, frame.embedding)
  try {
    let arrived = SETTLED_FRAMES
    for (let round = 0; round < ROUNDS; round++) {
      const olderIds = [...acknowledged.keys()]
      const arriving = framesFrom(centres, arrived, ARRIVING_FRAMES)
      const inserted = await opened.insertBatch(INDEX, arriving)
      expect(inserted.failed).toEqual([])
      for (const frame of arriving) acknowledged.set(frame.id, frame.embedding)
      arrived += ARRIVING_FRAMES
      let next = 0
      while (await placementUnderWay(opened)) {
        const probes = Array.from({ length: PROBES_IN_FLIGHT }, (_, slot) =>
          probe(opened, acknowledged, olderIds[(next + slot) % olderIds.length], record),
        )
        await Promise.all(probes)
        next += PROBES_IN_FLIGHT
      }
    }
    return record
  } finally {
    await opened.shutdown()
  }
}

describe('vector searches while a pass places arriving vectors', () => {
  it(
    'finds the nearest acknowledged vectors that an exact scan finds while the main thread places a batch between searches',
    async () => {
      const record = await searchEveryOlderVectorWhileArrivalsArePlaced(
        { workers: { enabled: false } },
        PLACEMENT_DEPTH_ON_THE_MAIN_THREAD,
      )

      expect(record.missed).toEqual([])
      expect(record.besideAPass).toBeGreaterThanOrEqual(SEARCHES_BESIDE_A_PASS_AT_LEAST)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!built)(
    'finds the nearest acknowledged vectors that an exact scan finds while worker threads place a batch',
    async () => {
      const record = await searchEveryOlderVectorWhileArrivalsArePlaced({}, PLACEMENT_DEPTH_ON_WORKER_THREADS)

      expect(record.missed).toEqual([])
      expect(record.besideAPass).toBeGreaterThanOrEqual(SEARCHES_BESIDE_A_PASS_AT_LEAST)
    },
    TEST_TIMEOUT_MS,
  )
})
