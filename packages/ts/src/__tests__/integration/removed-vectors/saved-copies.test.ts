import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  type Corpus,
  expectNearest,
  indexConfig,
  large,
  openPapers,
  openPapersWithoutTheRing,
  reembed,
  removeChanged,
  ringRecall,
  searchWithTheHostBinary,
  untilGraphSettled,
} from './fixtures'

const SAVED_RING_RECALL_FLOOR = 0.885

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

async function restoreSnapshotOf(source: Narsil): Promise<Narsil> {
  const bytes = await source.snapshot('papers')
  const restored = await createNarsil({ workers: { enabled: false } })
  await restored.createIndex('papers', indexConfig)
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

  it.skipIf(!available)(
    "keeps its recall after a checkpoint and a restart once the ring beyond each query's nearest ten is removed",
    async () => {
      const writer = await openPapersWithoutTheRing({ workers: { enabled: false }, durability: { directory } })
      narsil = await restartAfterCheckpoint(directory, writer)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(SAVED_RING_RECALL_FLOOR)
    },
  )

  it.skipIf(!available)(
    "keeps its recall after a snapshot restore once the ring beyond each query's nearest ten is removed",
    async () => {
      const source = await openPapersWithoutTheRing({ workers: { enabled: false } })
      narsil = await restoreSnapshotOf(source)
      expect(await ringRecall(narsil)).toBeGreaterThanOrEqual(SAVED_RING_RECALL_FLOOR)
    },
  )
})
