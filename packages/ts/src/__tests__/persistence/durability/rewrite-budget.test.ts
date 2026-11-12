import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilConfig } from '../../../types/config'
import { bodyOf, partitionCheckpointFileBytes, partitionSegmentIds } from './saved-size-oracle'

const INDEX = 'letters'
const PARTITIONS = 8
const ROUNDS = 10
const DOCUMENTS_PER_ROUND = 320
const BODY_LENGTH = 300
const REWRITE_BYTES = 4096
const MEASURED_CHECKPOINTS = 5

interface PartitionFiles {
  ids: Set<string>
  bytes: number
}

function partitionFiles(directory: string): PartitionFiles[] {
  return Array.from({ length: PARTITIONS }, (_, partitionId) => ({
    ids: partitionSegmentIds(directory, INDEX, partitionId),
    bytes: partitionCheckpointFileBytes(directory, INDEX, partitionId),
  }))
}

function idOf(round: number, at: number): string {
  return `letter-${round}-${at}`
}

describe.each(['memory', 'disk'] as const)('a small rewrite budget with text in %s', textStorage => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-rewrite-budget-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it('still shrinks every partition above the removed share at every checkpoint, one segment each', async () => {
    engine = await createNarsil({
      durability: {
        directory,
        checkpointIntervalMs: 0,
        checkpointMutationThreshold: 1_000_000_000,
        rewriteBytesPerCheckpoint: REWRITE_BYTES,
      },
      workers: { enabled: false },
    })
    await engine.createIndex(INDEX, {
      schema: { title: 'string', body: 'string' },
      partitions: { maxPartitions: PARTITIONS },
      textStorage,
    })
    for (let round = 0; round < ROUNDS; round++) {
      const batch = Array.from({ length: DOCUMENTS_PER_ROUND }, (_, at) => ({
        id: idOf(round, at),
        title: `letter ${round} ${at}`,
        body: bodyOf(round * DOCUMENTS_PER_ROUND + at, BODY_LENGTH),
      }))
      expect((await engine.insertBatch(INDEX, batch)).failed).toEqual([])
      await engine.checkpoint(INDEX)
    }
    const removed: string[] = []
    for (let round = 0; round < ROUNDS; round++) {
      for (let at = 0; at < DOCUMENTS_PER_ROUND; at += 2) removed.push(idOf(round, at))
    }
    expect((await engine.removeBatch(INDEX, removed)).failed).toEqual([])
    await engine.checkpoint(INDEX)

    for (let step = 0; step < MEASURED_CHECKPOINTS; step++) {
      const before = partitionFiles(directory)
      await engine.checkpoint(INDEX)
      const after = partitionFiles(directory)
      for (let partitionId = 0; partitionId < PARTITIONS; partitionId++) {
        const written = [...after[partitionId].ids].filter(id => !before[partitionId].ids.has(id))
        expect({ step, partitionId, written: written.length }).toEqual({ step, partitionId, written: 1 })
        expect(after[partitionId].bytes).toBeLessThan(before[partitionId].bytes)
      }
    }

    const live = ROUNDS * DOCUMENTS_PER_ROUND - removed.length
    expect(await engine.countDocuments(INDEX)).toBe(live)
    expect(await engine.get(INDEX, idOf(3, 1))).toMatchObject({ title: 'letter 3 1' })
    expect(await engine.get(INDEX, idOf(3, 2))).toBeUndefined()
  }, 120_000)
})

describe('the rewrite budget setting', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-rewrite-budget-setting-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([0, -1, 1.5, Number.NaN, '4096'])('refuses %s with CONFIG_INVALID', async rewriteBytesPerCheckpoint => {
    const config = { durability: { directory, rewriteBytesPerCheckpoint } } as unknown as NarsilConfig
    await expect(createNarsil(config)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('opens both tiers with a valid budget', async () => {
    const logTier = await createNarsil({ durability: { directory, rewriteBytesPerCheckpoint: 1 } })
    await logTier.shutdown()
    const snapshotTier = await createNarsil({
      persistence: createFilesystemPersistence({ directory: join(directory, 'snapshot') }),
      durability: { tier: 'snapshot', rewriteBytesPerCheckpoint: REWRITE_BYTES },
    })
    await snapshotTier.shutdown()
  })
})
