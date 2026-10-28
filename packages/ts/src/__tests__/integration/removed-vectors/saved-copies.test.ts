import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  type Corpus,
  indexConfig,
  indexConfigOf,
  large,
  openPapers,
  openPapersWithoutTheRing,
  outsideTheRing,
  type Paper,
  queryAnswers,
  recallAgainst,
  reembed,
  removeChanged,
  ringAnswers,
  ringRecall,
  searchWithTheHostBinary,
  untilGraphSettled,
} from './fixtures'

const LIVE_RING_RECALL_FLOOR = 0.9
const COPY_RECALL_FLOOR = 0.9
const COPY_TIMEOUT_MS = 60_000

interface Change {
  change: string
  apply: (narsil: Narsil, corpus: Corpus) => Promise<void>
  nearestHeld: ((corpus: Corpus) => Paper[]) | null
}

const changes: Change[] = [
  { change: 'most vectors are removed', apply: removeChanged, nearestHeld: corpus => corpus.kept },
  { change: 'most documents are re-embedded far away', apply: reembed, nearestHeld: null },
]

type Answers = (narsil: Narsil) => Promise<string[][]>

interface Carried {
  copy: Narsil
  answeredOnceCopied: string[][]
}

async function restartAfterCheckpoint(directory: string, writer: Narsil, answers: Answers): Promise<Carried> {
  await writer.checkpoint('papers')
  const answeredOnceCopied = await answers(writer)
  await writer.shutdown()
  const copy = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  await untilGraphSettled(copy)
  return { copy, answeredOnceCopied }
}

const quantizations = [{ quantization: 'none' as const }, { quantization: 'osq4' as const }]

async function restoreSnapshotOf(
  source: Narsil,
  answers: Answers,
  papersConfig: IndexConfig = indexConfig,
): Promise<Carried> {
  const bytes = await source.snapshot('papers')
  const answeredOnceCopied = await answers(source)
  const copy = await createNarsil({ workers: { enabled: false } })
  await copy.createIndex('papers', papersConfig)
  await copy.restore('papers', bytes)
  await source.shutdown()
  await untilGraphSettled(copy)
  return { copy, answeredOnceCopied }
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
    'answers after a checkpoint and a restart as the writer did once $change',
    async ({ apply, nearestHeld }) => {
      const writer = await openPapers({ workers: { enabled: false }, durability: { directory } }, large.documents)
      await apply(writer, large)
      const { copy, answeredOnceCopied } = await restartAfterCheckpoint(directory, writer, queryAnswers)
      narsil = copy
      expect(await queryAnswers(copy)).toEqual(answeredOnceCopied)
      if (nearestHeld !== null) {
        expect(await recallAgainst(copy, nearestHeld(large))).toBeGreaterThanOrEqual(COPY_RECALL_FLOOR)
      }
    },
    COPY_TIMEOUT_MS,
  )

  it.skipIf(!available).each(changes)(
    'answers after a snapshot restore as the source did once $change',
    async ({ apply, nearestHeld }) => {
      const source = await openPapers({ workers: { enabled: false } }, large.documents)
      await apply(source, large)
      const { copy, answeredOnceCopied } = await restoreSnapshotOf(source, queryAnswers)
      narsil = copy
      expect(await queryAnswers(copy)).toEqual(answeredOnceCopied)
      if (nearestHeld !== null) {
        expect(await recallAgainst(copy, nearestHeld(large))).toBeGreaterThanOrEqual(COPY_RECALL_FLOOR)
      }
    },
    COPY_TIMEOUT_MS,
  )

  it.skipIf(!available).each(quantizations)(
    "answers as the live graph did after a checkpoint and a restart once the ring beyond each query's nearest ten is removed, at $quantization",
    async ({ quantization }) => {
      const config = { workers: { enabled: false }, durability: { directory } }
      const writer = await openPapersWithoutTheRing(config, indexConfigOf(quantization))
      const { copy, answeredOnceCopied } = await restartAfterCheckpoint(directory, writer, ringAnswers)
      narsil = copy
      expect(await ringAnswers(copy)).toEqual(answeredOnceCopied)
      expect(await ringRecall(copy)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    },
    COPY_TIMEOUT_MS,
  )

  it.skipIf(!available).each(quantizations)(
    "answers as the live graph did after a snapshot restore once the ring beyond each query's nearest ten is removed, at $quantization",
    async ({ quantization }) => {
      const source = await openPapersWithoutTheRing({ workers: { enabled: false } }, indexConfigOf(quantization))
      const { copy, answeredOnceCopied } = await restoreSnapshotOf(source, ringAnswers, indexConfigOf(quantization))
      narsil = copy
      expect(await ringAnswers(copy)).toEqual(answeredOnceCopied)
      expect(await ringRecall(copy)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    },
    COPY_TIMEOUT_MS,
  )

  it.skipIf(!available).each(quantizations)(
    'answers as the live graph did after a second checkpoint and restart that carry the same tombstones, at $quantization',
    async ({ quantization }) => {
      const config = { workers: { enabled: false }, durability: { directory } }
      const writer = await openPapersWithoutTheRing(config, indexConfigOf(quantization))
      const first = await restartAfterCheckpoint(directory, writer, ringAnswers)
      narsil = first.copy
      await first.copy.remove('papers', outsideTheRing[0].id)
      const second = await restartAfterCheckpoint(directory, first.copy, ringAnswers)
      narsil = second.copy
      expect(await ringAnswers(second.copy)).toEqual(second.answeredOnceCopied)
    },
    COPY_TIMEOUT_MS,
  )
})
