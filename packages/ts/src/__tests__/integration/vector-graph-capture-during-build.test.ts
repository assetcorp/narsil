import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import { waitFor } from '../server/helpers'
import { bytesOf, walkSavedGraph } from './saved-graph-walk'

const built = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))

const DIMENSION = 24
const PROMOTION_THRESHOLD = 100
const SETTLED_FRAMES = 1_500
const ARRIVING_BATCH = 128
const FRAMES_KEPT_WAITING = 1_000
const WRITER_POLL_MS = 1
const CAPTURES = 8
const CAPTURES_AT_ONCE = 2
const SETTLE_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 300_000
const INDEX = 'frames'
const RESTORED_INDEX = 'restored-frames'
const FIELDS = ['embedding', 'thumbnail'] as const

type Frame = {
  id: string
  title: string
  embedding: number[]
  thumbnail: number[]
}

interface SavedGraphReach {
  capture: number
  field: string
  live: number
  unplaced: number
  unreached: number
}

function seeded(seed: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(DIMENSION)
  for (let i = 0; i < DIMENSION; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values[i] = Math.fround(state / 2147483648 - 1)
  }
  return values
}

function framesFrom(first: number, count: number): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `frame-${first + i}`,
    title: `frame ${first + i}`,
    embedding: seeded(2 * (first + i) + 1),
    thumbnail: seeded(2 * (first + i) + 2),
  }))
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function openSettledFrames(config: NarsilConfig): Promise<Narsil> {
  const opened = await createNarsil(config)
  await opened.createIndex(INDEX, {
    schema: { title: 'string', embedding: `vector[${DIMENSION}]`, thumbnail: `vector[${DIMENSION}]` },
    vectorPromotion: {
      threshold: PROMOTION_THRESHOLD,
      quantization: 'none',
      hnswConfig: { m: 4, efConstruction: 40, metric: 'euclidean' },
    },
  })
  const settled = await opened.insertBatch(INDEX, framesFrom(0, SETTLED_FRAMES))
  expect(settled.failed).toEqual([])
  await waitFor(async () => {
    const fields = opened.vectorMaintenanceStatus(INDEX)
    return (
      fields.length === FIELDS.length &&
      fields.every(field => field.graphCount === 1 && field.bufferSize === 0 && !field.building)
    )
  }, SETTLE_TIMEOUT_MS)
  return opened
}

function framesWaitingForAGraph(opened: Narsil): number {
  return Math.max(...opened.vectorMaintenanceStatus(INDEX).map(field => field.bufferSize))
}

type Archive = Uint8Array<ArrayBuffer>

async function captureWhileFramesArrive(opened: Narsil, capturesAtOnce = 1): Promise<Archive[]> {
  let capturing = true
  let arrived = SETTLED_FRAMES
  const writer = (async () => {
    while (capturing) {
      if (framesWaitingForAGraph(opened) < FRAMES_KEPT_WAITING) {
        const batch = await opened.insertBatch(INDEX, framesFrom(arrived, ARRIVING_BATCH))
        expect(batch.failed).toEqual([])
        arrived += ARRIVING_BATCH
      }
      await pause(WRITER_POLL_MS)
    }
  })()
  writer.catch(() => undefined)
  const archives: Archive[] = []
  let started = 0
  const takeCaptures = async (): Promise<void> => {
    while (started < CAPTURES) {
      started += 1
      await waitFor(async () => framesWaitingForAGraph(opened) > 0, SETTLE_TIMEOUT_MS)
      archives.push(await bytesOf(await opened.snapshot(INDEX)))
    }
  }
  try {
    await Promise.all(Array.from({ length: capturesAtOnce }, takeCaptures))
  } finally {
    capturing = false
    await writer
  }
  return archives
}

async function whileGraphsAreOptimised<T>(opened: Narsil, work: () => Promise<T>): Promise<T> {
  let optimising = true
  const optimiser = (async () => {
    while (optimising) {
      await opened.optimizeVectors(INDEX)
      await pause(WRITER_POLL_MS)
    }
  })()
  try {
    return await work()
  } finally {
    optimising = false
    await optimiser
  }
}

async function untilEveryFrameHasAPlace(opened: Narsil): Promise<void> {
  await waitFor(
    async () => opened.vectorMaintenanceStatus(INDEX).every(field => field.bufferSize === 0 && !field.building),
    SETTLE_TIMEOUT_MS,
  )
}

async function reachOfEverySavedGraph(archives: readonly Archive[]): Promise<SavedGraphReach[]> {
  const reach: SavedGraphReach[] = []
  for (let capture = 0; capture < archives.length; capture++) {
    for (const field of FIELDS) {
      const walk = await walkSavedGraph(new Blob([archives[capture]]).stream(), INDEX, field)
      expect(walk.graphCount).toBe(1)
      reach.push({
        capture,
        field,
        live: walk.liveDocIds.length,
        unplaced: walk.unplaced.length,
        unreached: walk.unreached.length,
      })
    }
  }
  return reach
}

async function expectEveryArchiveToRestore(archives: readonly Archive[]): Promise<void> {
  const reader = await createNarsil({ workers: { enabled: false } })
  try {
    for (const archive of archives) {
      const saved = await walkSavedGraph(new Blob([archive]).stream(), INDEX, FIELDS[0])
      await reader.restore(RESTORED_INDEX, archive)
      expect(await reader.countDocuments(RESTORED_INDEX)).toBe(saved.liveDocIds.length)
      await reader.dropIndex(RESTORED_INDEX)
    }
  } finally {
    await reader.shutdown()
  }
}

async function expectEverySavedGraphToReachItsVectors(archives: readonly Archive[]): Promise<void> {
  expect(archives).toHaveLength(CAPTURES)
  const reach = await reachOfEverySavedGraph(archives)
  expect(reach.filter(saved => saved.unreached > 0)).toEqual([])
  expect(reach.filter(saved => saved.unplaced > 0).length).toBeGreaterThan(0)
  await expectEveryArchiveToRestore(archives)
}

describe.skipIf(!built)('a vector graph saved while worker threads place arriving vectors', () => {
  let engine: Narsil | null = null
  let directory = ''

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    if (directory !== '') await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it(
    'reaches every live vector in every snapshot archive that an engine without durability writes',
    async () => {
      const opened = await openSettledFrames({})
      engine = opened

      await expectEverySavedGraphToReachItsVectors(await captureWhileFramesArrive(opened))
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'reaches every live vector in every checkpoint that a durable engine writes for a snapshot',
    async () => {
      directory = await mkdtemp(join(tmpdir(), 'narsil-capture-during-build-'))
      const opened = await openSettledFrames({ durability: { directory } })
      engine = opened

      await expectEverySavedGraphToReachItsVectors(await captureWhileFramesArrive(opened))
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finishes two snapshots at a time beside optimise calls, and places every vector that arrived once they end',
    async () => {
      const opened = await openSettledFrames({})
      engine = opened

      const archives = await whileGraphsAreOptimised(opened, () => captureWhileFramesArrive(opened, CAPTURES_AT_ONCE))
      await untilEveryFrameHasAPlace(opened)

      await expectEverySavedGraphToReachItsVectors(archives)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'settles every snapshot when the engine shuts down while snapshots are under way',
    async () => {
      const opened = await openSettledFrames({})

      const captures = captureWhileFramesArrive(opened, CAPTURES_AT_ONCE).then(
        () => 'captured',
        () => 'refused',
      )
      await waitFor(async () => framesWaitingForAGraph(opened) > 0, SETTLE_TIMEOUT_MS)
      await opened.shutdown()

      expect(['captured', 'refused']).toContain(await captures)
    },
    TEST_TIMEOUT_MS,
  )
})
