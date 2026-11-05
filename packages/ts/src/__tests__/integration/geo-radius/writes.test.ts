import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../../narsil'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { scaledOut, waitFor } from '../../server/helpers'
import { INDEX } from './fixtures'
import { haversineMetres, type Point } from './oracle'

const TEST_TIMEOUT_MS = 180_000
const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const SEED = 20_261_105
const SOUTH = 51.3
const NORTH = 51.7
const WEST = -0.5
const EAST = 0.3
const STARTING_POINTS = 4_000
const ROUNDS_PER_PHASE = 12
const CHECKPOINT_EVERY_ROUNDS = 4
const INSERTS_PER_ROUND = 60
const MOVES_PER_ROUND = 45
const REMOVALS_PER_ROUND = 35
const RETURNS_PER_ROUND = 10
const QUERIES_PER_ROUND = 3
const RADII_METRES = [30, 300, 2_000, 9_000]
const EDGE_MARGIN_RATIO = 1e-6
const RESULT_LIMIT = 10_000
const PLACE_KIND = 'place'
const WORKER_COPIES = { promotionThreshold: 200, count: 2, mainCopyQueries: 'none' as const }
const SHARED_SPOT_SHARE = 0.25
const SHARED_SPOTS: readonly Point[] = [
  { lat: 51.5072, lon: -0.1276 },
  { lat: 51.5033, lon: -0.1196 },
  { lat: 51.4545, lon: -0.0983 },
]

interface Places {
  readonly stored: Map<string, Point>
  readonly departed: string[]
  nextId: number
  readonly draw: () => number
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

function pointFrom(draw: () => number): Point {
  return { lat: SOUTH + draw() * (NORTH - SOUTH), lon: WEST + draw() * (EAST - WEST) }
}

function pick<T>(draw: () => number, items: readonly T[]): T {
  return items[Math.floor(draw() * items.length)]
}

function placeFrom(draw: () => number): Point {
  if (draw() < SHARED_SPOT_SHARE) return { ...pick(draw, SHARED_SPOTS) }
  return pointFrom(draw)
}

async function freshModules() {
  vi.resetModules()
  const [engine, dispatch] = await Promise.all([
    import('../../../narsil'),
    import('../../../persistence/durability/checkpoint-worker-dispatch'),
  ])
  return { engine, dispatch }
}

function wronglyMatched(stored: ReadonlyMap<string, Point>, found: ReadonlySet<string>, centre: Point, radius: number) {
  const wrong: string[] = []
  for (const id of found) {
    if (!stored.has(id)) wrong.push(`${id} is gone but matched`)
  }
  for (const [id, point] of stored) {
    const distance = haversineMetres(centre, point)
    if (Math.abs(distance - radius) <= radius * EDGE_MARGIN_RATIO) continue
    if (found.has(id) !== distance <= radius) wrong.push(`${id} at ${distance} m`)
  }
  return wrong
}

async function expectRadiusSearches(engine: Narsil, places: Places, label: string): Promise<void> {
  for (let query = 0; query < QUERIES_PER_ROUND; query++) {
    const centre = query === 0 ? pick(places.draw, SHARED_SPOTS) : pointFrom(places.draw)
    const radius = pick(places.draw, RADII_METRES)
    const result = await engine.query(INDEX, {
      term: PLACE_KIND,
      filters: { fields: { location: { radius: { ...centre, distance: radius, unit: 'm' } } } },
      limit: RESULT_LIMIT,
    })
    const found = new Set(result.hits.map(hit => String(hit.id)))
    expect(found.size, `${label}, ${radius} m`).toBe(result.count)
    expect(wronglyMatched(places.stored, found, centre, radius), `${label}, ${radius} m`).toEqual([])
  }
}

async function applyWrites(engine: Narsil, places: Places): Promise<void> {
  const { stored, departed, draw } = places
  const arrivals = Array.from({ length: INSERTS_PER_ROUND }, () => ({
    id: `place-${places.nextId++}`,
    kind: PLACE_KIND,
    location: placeFrom(draw),
  }))
  for (let returning = 0; returning < RETURNS_PER_ROUND && departed.length > 0; returning++) {
    const id = departed.splice(Math.floor(draw() * departed.length), 1)[0]
    arrivals.push({ id, kind: PLACE_KIND, location: placeFrom(draw) })
  }
  expect((await engine.insertBatch(INDEX, arrivals)).failed).toEqual([])
  for (const document of arrivals) stored.set(document.id, document.location)

  const present = [...stored.keys()]
  for (let move = 0; move < MOVES_PER_ROUND; move++) {
    const id = pick(draw, present)
    const location = placeFrom(draw)
    await engine.update(INDEX, id, { kind: PLACE_KIND, location })
    stored.set(id, location)
  }

  const leaving = new Set<string>()
  while (leaving.size < REMOVALS_PER_ROUND) leaving.add(pick(draw, present))
  expect((await engine.removeBatch(INDEX, [...leaving])).failed).toEqual([])
  for (const id of leaving) {
    stored.delete(id)
    departed.push(id)
  }
  await engine.waitForWrites(INDEX)
}

describe('radius searches while documents arrive, move, leave, and come back', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-geo-writes-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.skipIf(!WORKERS_BUILT)(
    'match exactly the stored points through checkpoints, a restart, and a restore onto worker copies',
    async () => {
      const draw = seeded(SEED)
      const places: Places = { stored: new Map(), departed: [], nextId: STARTING_POINTS, draw }

      const writer = await freshModules()
      writer.dispatch.resetCheckpointWorkerLatch()
      const durable = await writer.engine.createNarsil({ workers: { enabled: false }, durability: { directory: root } })
      try {
        await durable.createIndex(INDEX, { schema: { kind: 'string', location: 'geopoint' } })
        const starting = Array.from({ length: STARTING_POINTS }, (_, position) => ({
          id: `place-${position}`,
          kind: PLACE_KIND,
          location: placeFrom(draw),
        }))
        expect((await durable.insertBatch(INDEX, starting)).failed).toEqual([])
        for (const document of starting) places.stored.set(document.id, document.location)
        await durable.checkpoint(INDEX)
        for (let round = 0; round < ROUNDS_PER_PHASE; round++) {
          await applyWrites(durable, places)
          if ((round + 1) % CHECKPOINT_EVERY_ROUNDS === 0) {
            await durable.checkpoint(INDEX)
            expect(writer.dispatch.__checkpointWorkerIsPooledForTests(), `checkpoint after round ${round}`).toBe(true)
          }
          await expectRadiusSearches(durable, places, `written, round ${round}`)
        }
      } finally {
        await durable.shutdown()
        writer.dispatch.resetCheckpointWorkerLatch()
      }

      const reopened = await freshModules()
      const restarted = await reopened.engine.createNarsil({
        workers: { enabled: false },
        durability: { directory: root },
      })
      let archive: Uint8Array
      try {
        await expectRadiusSearches(restarted, places, 'after the restart')
        archive = await bytesOf(await restarted.snapshot(INDEX))
      } finally {
        await restarted.shutdown()
      }

      const reader = await freshModules()
      const copies = await reader.engine.createNarsil({ workers: WORKER_COPIES })
      try {
        await copies.restore(INDEX, archive)
        await expectRadiusSearches(copies, places, 'restored')
        for (let round = 0; round < ROUNDS_PER_PHASE; round++) {
          await applyWrites(copies, places)
          if (round === 0) await waitFor(() => scaledOut(copies, INDEX))
          await expectRadiusSearches(copies, places, `worker copies, round ${round}`)
        }
      } finally {
        await copies.shutdown()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
