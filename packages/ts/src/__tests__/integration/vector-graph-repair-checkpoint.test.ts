import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ failWriteOf: null as RegExp | null, hits: 0 }))
const checkpoints = vi.hoisted(() => ({
  running: 0,
  most: 0,
  started: 0,
  held: 0,
  gate: null as Promise<void> | null,
}))

vi.mock('../../persistence/durability/durable-filesystem', async importOriginal => {
  const original = await importOriginal<typeof import('../../persistence/durability/durable-filesystem')>()
  return {
    ...original,
    createDurableDirectory: (root: string) => {
      const directory = original.createDurableDirectory(root)
      return {
        ...directory,
        root: directory.root,
        async atomicWrite(key: string, data: Uint8Array | readonly Uint8Array[]) {
          if (faults.failWriteOf?.test(key)) {
            faults.hits += 1
            throw new Error(`simulated crash writing "${key}"`)
          }
          return directory.atomicWrite(key, data)
        },
      }
    },
  }
})

vi.mock('../../persistence/durability/checkpoint-worker-dispatch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../persistence/durability/checkpoint-worker-dispatch')>()),
  checkpointWorkerIsUsable: () => false,
  runCheckpointOnWorker: async () => null,
}))

vi.mock('../../persistence/durability/checkpoint-run', async importOriginal => {
  const actual = await importOriginal<typeof import('../../persistence/durability/checkpoint-run')>()
  return {
    ...actual,
    async runDurableCheckpoint(input: Parameters<typeof actual.runDurableCheckpoint>[0]) {
      checkpoints.running += 1
      checkpoints.started += 1
      checkpoints.most = Math.max(checkpoints.most, checkpoints.running)
      try {
        const gate = checkpoints.gate
        if (gate !== null) {
          checkpoints.held += 1
          await gate
          checkpoints.held -= 1
        }
        return await actual.runDurableCheckpoint(input)
      } finally {
        checkpoints.running -= 1
      }
    },
  }
})

import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import { savedShuffledBuildCount } from '../e2e/portability/archive-oracle'
import { temporaryRoots } from '../e2e/portability/harness'
import { waitFor } from '../server/helpers'
import {
  DIMENSION,
  FIELD,
  insertFileByFile,
  NARROW_EF_SEARCH,
  NARROW_LIMIT,
  type Passage,
  passagesArrivingFileByFile,
  passagesNotFoundFirst,
  SETTLE_TIMEOUT_MS,
  snapshotFromAnEarlierRelease,
  untilSettled,
} from './passages-by-file'

const SAVED_PASSAGES = 2_000
const INDEX = 'passages'
const RESTORED_INDEX = 'earlier'
const TEST_TIMEOUT_MS = 300_000

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  faults.failWriteOf = null
  faults.hits = 0
  checkpoints.gate = null
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

async function opened(config: NarsilConfig): Promise<Narsil> {
  const engine = await createNarsil(config)
  engines.push(engine)
  return engine
}

async function restoreAGraphFromAnEarlierRelease(engine: Narsil): Promise<Passage[]> {
  const passages = passagesArrivingFileByFile(SAVED_PASSAGES)
  await engine.createIndex(INDEX, {
    schema: { [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: { quantization: 'osq4', threshold: SAVED_PASSAGES },
  })
  await insertFileByFile(engine, INDEX, passages)
  const earlier = await snapshotFromAnEarlierRelease(engine, INDEX, SAVED_PASSAGES)
  await engine.dropIndex(INDEX)
  await engine.restore(RESTORED_INDEX, earlier)
  return passages
}

describe('the checkpoint that follows the repair of a graph from an earlier release', () => {
  it(
    'waits for a checkpoint in flight, and then saves the rebuilt graph with its count',
    async () => {
      const directory = await roots.make('narsil-repair-turn-')
      const engine = await opened({ workers: { enabled: false }, durability: { directory, checkpointIntervalMs: 0 } })
      await restoreAGraphFromAnEarlierRelease(engine)
      let release = (): void => undefined
      checkpoints.gate = new Promise<void>(resolve => {
        release = resolve
      })
      checkpoints.most = checkpoints.running
      const inFlight = engine.checkpoint(RESTORED_INDEX)

      await waitFor(async () => checkpoints.held === 1, SETTLE_TIMEOUT_MS)
      const startedWhileHeld = checkpoints.started
      await untilSettled(engine, RESTORED_INDEX)
      expect(checkpoints.running).toBe(1)
      expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBeNull()

      checkpoints.gate = null
      release()
      await inFlight
      await waitFor(async () => checkpoints.started > startedWhileHeld && checkpoints.running === 0, SETTLE_TIMEOUT_MS)

      expect(checkpoints.most).toBe(1)
      expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBe(SAVED_PASSAGES)
    },
    TEST_TIMEOUT_MS,
  )

  for (const [stage, fault] of [
    ['writing the rebuilt graph', /^earlier\/segments\/vec-.*-graph-g\d+-p\d{16}$/],
    ['committing its manifest', /^earlier\/manifest$/],
  ] as const) {
    it(
      `leaves the checkpoint before it loadable when a crash stops it ${stage}`,
      async () => {
        const directory = await roots.make('narsil-repair-crash-')
        const config: NarsilConfig = { workers: { enabled: false }, durability: { directory, checkpointIntervalMs: 0 } }
        const engine = await opened(config)
        const passages = await restoreAGraphFromAnEarlierRelease(engine)
        faults.failWriteOf = fault

        await waitFor(async () => faults.hits > 0, SETTLE_TIMEOUT_MS)
        expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBeNull()
        await engine.shutdown().catch(() => undefined)
        faults.failWriteOf = null

        const reopened = await opened(config)
        expect(await reopened.countDocuments(RESTORED_INDEX)).toBe(SAVED_PASSAGES)
        await untilSettled(reopened, RESTORED_INDEX)
        await waitFor(
          async () => (await savedShuffledBuildCount(directory, RESTORED_INDEX)) !== null,
          SETTLE_TIMEOUT_MS,
        )
        expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBe(SAVED_PASSAGES)
        expect(await passagesNotFoundFirst(reopened, RESTORED_INDEX, passages, NARROW_LIMIT, NARROW_EF_SEARCH)).toEqual(
          [],
        )
      },
      TEST_TIMEOUT_MS,
    )
  }
})
