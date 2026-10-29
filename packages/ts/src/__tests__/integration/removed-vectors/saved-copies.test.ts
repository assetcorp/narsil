import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  indexConfig,
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
})
