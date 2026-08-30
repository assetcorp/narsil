import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHeldPartitionRecord } from '../../../distribution/cluster-node/held-partitions'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import type { EngineCore, IndexRegistryEntry } from '../../../engine/core'

const INDEX_NAME = 'products'
const INDEX_UUID = '4d1e8f02-7c3a-4b96-8e5d-1a2b3c4d5e6f'
const PARTITION_COUNT = 8

function coreThatFailsToPersist(failures: number): { core: EngineCore; attempts: () => number } {
  const indexRegistry = new Map<string, IndexRegistryEntry>([
    [INDEX_NAME, { heldPartitions: null } as unknown as IndexRegistryEntry],
  ])
  let attempts = 0
  const core = {
    indexRegistry,
    durability: {
      manager: {
        persistMetadata: async () => {
          attempts += 1
          if (attempts <= failures) {
            throw new Error('the metadata write failed')
          }
        },
      },
    },
  } as unknown as EngineCore
  return { core, attempts: () => attempts }
}

describe('a record whose write to disk fails', () => {
  it('keeps answering for the partition while the node stays up', async () => {
    const { core } = coreThatFailsToPersist(1)
    const record = createHeldPartitionRecord(core)

    await expect(record.record(INDEX_NAME, 3)).rejects.toThrow('the metadata write failed')

    expect(record.held(INDEX_NAME)).toEqual([3])
  })

  it('writes the record again on the next attempt, so the disk catches up', async () => {
    const { core, attempts } = coreThatFailsToPersist(1)
    const record = createHeldPartitionRecord(core)
    await expect(record.record(INDEX_NAME, 3)).rejects.toThrow('the metadata write failed')

    await record.record(INDEX_NAME, 3)

    expect(attempts()).toBe(2)
    expect(record.held(INDEX_NAME)).toEqual([3])
  })

  it('stops writing again once the disk holds the record', async () => {
    const { core, attempts } = coreThatFailsToPersist(1)
    const record = createHeldPartitionRecord(core)
    await expect(record.record(INDEX_NAME, 3)).rejects.toThrow('the metadata write failed')
    await record.record(INDEX_NAME, 3)

    await record.record(INDEX_NAME, 3)

    expect(attempts()).toBe(2)
  })
})

describe('the record of which partitions a copy holds', () => {
  let directory: string
  let engine: ClusterLocalEngine | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-held-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = undefined
    await rm(directory, { recursive: true, force: true })
  })

  async function startEngine(): Promise<ClusterLocalEngine> {
    return createClusterLocalEngine({ durability: { directory } })
  }

  it('survives a restart holding exactly what the node last recorded', async () => {
    engine = await startEngine()
    await engine.createIndexWithUuid(
      INDEX_NAME,
      { schema: { title: 'string' }, partitions: { maxPartitions: PARTITION_COUNT } },
      INDEX_UUID,
    )

    const writes: Array<Promise<void>> = []
    for (let partitionId = 0; partitionId < PARTITION_COUNT; partitionId += 1) {
      writes.push(engine.recordHeldPartition(INDEX_NAME, partitionId))
    }
    for (let partitionId = 0; partitionId < PARTITION_COUNT; partitionId += 2) {
      writes.push(engine.forgetHeldPartition(INDEX_NAME, partitionId))
    }
    await Promise.all(writes)

    const live = engine.heldPartitionsOf(INDEX_NAME)
    expect(live).toEqual([1, 3, 5, 7])

    await engine.shutdown()
    engine = await startEngine()

    expect(engine.heldPartitionsOf(INDEX_NAME)).toEqual(live)
  }, 30_000)
})
