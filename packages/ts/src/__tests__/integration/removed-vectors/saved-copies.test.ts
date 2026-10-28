import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  type Corpus,
  expectNearest,
  indexConfig,
  indexConfigOf,
  large,
  openPapers,
  openPapersWithoutTheRing,
  outsideTheRing,
  reembed,
  removeChanged,
  ringAnswers,
  ringRecall,
  searchWithTheHostBinary,
  untilGraphSettled,
} from './fixtures'

vi.setConfig({ testTimeout: 20_000 })

const LIVE_RING_RECALL_FLOOR = 0.9

const changes = [
  { change: 'most vectors are removed', apply: removeChanged, current: (corpus: Corpus) => corpus.kept },
  {
    change: 'most documents are re-embedded far away',
    apply: reembed,
    current: (corpus: Corpus) => [...corpus.kept, ...corpus.reembedded],
  },
]

async function restartAfterCheckpoint(directory: string, writer: Narsil): Promise<Narsil> {
  await writer.checkpoint('papers')
  await writer.shutdown()
  const reader = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  await untilGraphSettled(reader)
  return reader
}

const quantizations = [{ quantization: 'none' as const }, { quantization: 'osq4' as const }]

async function restoreSnapshotOf(source: Narsil, papersConfig: IndexConfig = indexConfig): Promise<Narsil> {
  const bytes = await source.snapshot('papers')
  const restored = await createNarsil({ workers: { enabled: false } })
  await restored.createIndex('papers', papersConfig)
  await restored.restore('papers', bytes)
  await source.shutdown()
  await untilGraphSettled(restored)
  return restored
}

searchWithTheHostBinary()

describe.each(backends)('a vector search past tombstones carried to another copy through $name', ({
  native,
  available,
}) => {
  let directory = ''
  let narsil: Narsil | null = null

  beforeEach(async () => {
    setNativeSearchCoreEnabled(native)
    directory = await mkdtemp(join(tmpdir(), 'narsil-tombstones-'))
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    setNativeSearchCoreEnabled(true)
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(!available).each(changes)(
    'answers after a checkpoint and a restart once $change',
    async ({ apply, current }) => {
      const writer = await openPapers({ workers: { enabled: false }, durability: { directory } }, large.documents)
      await apply(writer, large)
      narsil = await restartAfterCheckpoint(directory, writer)
      await expectNearest(narsil, current(large))
    },
  )

  it.skipIf(!available).each(changes)('answers after a snapshot restore once $change', async ({ apply, current }) => {
    const source = await openPapers({ workers: { enabled: false } }, large.documents)
    await apply(source, large)
    narsil = await restoreSnapshotOf(source)
    await expectNearest(narsil, current(large))
  })

  it.skipIf(!available).each(quantizations)(
    "answers as the live graph did after a checkpoint and a restart once the ring beyond each query's nearest ten is removed, at $quantization",
    async ({ quantization }) => {
      const config = { workers: { enabled: false }, durability: { directory } }
      const writer = await openPapersWithoutTheRing(config, indexConfigOf(quantization))
      const live = await ringAnswers(writer)
      narsil = await restartAfterCheckpoint(directory, writer)
      expect(await ringAnswers(narsil)).toEqual(live)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    },
  )

  it.skipIf(!available).each(quantizations)(
    "answers as the live graph did after a snapshot restore once the ring beyond each query's nearest ten is removed, at $quantization",
    async ({ quantization }) => {
      const source = await openPapersWithoutTheRing({ workers: { enabled: false } }, indexConfigOf(quantization))
      const live = await ringAnswers(source)
      narsil = await restoreSnapshotOf(source, indexConfigOf(quantization))
      expect(await ringAnswers(narsil)).toEqual(live)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    },
  )

  it.skipIf(!available).each(quantizations)(
    'answers as the live graph did after a second checkpoint and restart that carry the same tombstones, at $quantization',
    async ({ quantization }) => {
      const config = { workers: { enabled: false }, durability: { directory } }
      const writer = await openPapersWithoutTheRing(config, indexConfigOf(quantization))
      const first = await restartAfterCheckpoint(directory, writer)
      await first.remove('papers', outsideTheRing[0].id)
      const live = await ringAnswers(first)
      narsil = await restartAfterCheckpoint(directory, first)
      expect(await ringAnswers(narsil)).toEqual(live)
    },
  )
})
