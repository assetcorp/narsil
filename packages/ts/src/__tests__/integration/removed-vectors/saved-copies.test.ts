import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  indexConfigOf,
  openPapersWithoutTheRing,
  ringAnswers,
  ringRecall,
  searchWithTheHostBinary,
  untilGraphSettled,
} from './fixtures'

vi.setConfig({ testTimeout: 20_000 })

const LIVE_RING_RECALL_FLOOR = 0.9
const COPY_TIMEOUT_MS = 60_000

const quantizations = [{ quantization: 'none' as const }, { quantization: 'osq4' as const }]

searchWithTheHostBinary()

describe.each(backends)('a vector search past tombstones carried to another copy through $name', ({
  native,
  available,
}) => {
  describe.skipIf(!available).each(quantizations)('with the ring removed at $quantization', ({ quantization }) => {
    let directory = ''
    let snapshotBytes: Uint8Array = new Uint8Array()
    let answeredAtSnapshot: string[][] = []
    let answeredAtCheckpoint: string[][] = []
    let copy: Narsil | null = null

    beforeAll(async () => {
      setNativeSearchCoreEnabled(native)
      directory = await mkdtemp(join(tmpdir(), 'narsil-tombstones-'))
      const writer = await openPapersWithoutTheRing(
        { workers: { enabled: false }, durability: { directory } },
        indexConfigOf(quantization),
      )
      try {
        snapshotBytes = new Uint8Array(await new Response(await writer.snapshot('papers')).arrayBuffer())
        answeredAtSnapshot = await ringAnswers(writer)
        await writer.checkpoint('papers')
        answeredAtCheckpoint = await ringAnswers(writer)
      } finally {
        await writer.shutdown()
      }
    }, COPY_TIMEOUT_MS)

    beforeEach(() => {
      setNativeSearchCoreEnabled(native)
    })

    afterEach(async () => {
      await copy?.shutdown()
      copy = null
      setNativeSearchCoreEnabled(true)
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    it(
      `answers as the live graph did after a checkpoint and a restart once the ring beyond each query's nearest ten is removed, at ${quantization}`,
      async () => {
        const restarted = await createNarsil({ workers: { enabled: false }, durability: { directory } })
        copy = restarted
        await untilGraphSettled(restarted)
        expect(await ringAnswers(restarted)).toEqual(answeredAtCheckpoint)
        expect(await ringRecall(restarted)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
      },
      COPY_TIMEOUT_MS,
    )

    it(
      `answers as the live graph did after a snapshot restore once the ring beyond each query's nearest ten is removed, at ${quantization}`,
      async () => {
        const restored = await createNarsil({ workers: { enabled: false } })
        copy = restored
        await restored.createIndex('papers', indexConfigOf(quantization))
        await restored.restore('papers', snapshotBytes)
        await untilGraphSettled(restored)
        expect(await ringAnswers(restored)).toEqual(answeredAtSnapshot)
        expect(await ringRecall(restored)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
      },
      COPY_TIMEOUT_MS,
    )
  })
})
