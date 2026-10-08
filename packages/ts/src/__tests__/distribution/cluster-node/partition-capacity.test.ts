import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import { ErrorCodes } from '../../../errors'
import type { NarsilEventMap } from '../../../types/events'
import type { PartitionConfig } from '../../../types/schema'

const INDEX_NAME = 'bookshelf'
const PARTITION_COUNT = 2

function docIdsInPartition(partitionId: number, prefix: string, count: number): string[] {
  const ids: string[] = []
  for (let i = 0; ids.length < count && i < 10_000; i += 1) {
    const candidate = `${prefix}-${i}`
    if (resolvePartitionId(candidate, PARTITION_COUNT) === partitionId) ids.push(candidate)
  }
  return ids
}

async function engineWithLimits(limits: PartitionConfig): Promise<ClusterLocalEngine> {
  const engine = await createClusterLocalEngine({ workers: { enabled: false } })
  await engine.createIndex(INDEX_NAME, {
    schema: { title: 'string' },
    partitions: { ...limits, maxPartitions: PARTITION_COUNT },
  })
  return engine
}

describe('partition capacity on a cluster node', () => {
  it('applies every replicated write, because only the primary checks capacity', async () => {
    const engine = await engineWithLimits({ maxDocsPerPartition: 1 })
    const ids = docIdsInPartition(0, 'novel', 3)

    try {
      for (const [position, documentId] of ids.entries()) {
        await engine.applyReplicationEntry(
          buildEntry({
            seqNo: position + 1,
            primaryTerm: 1,
            operation: 'INDEX',
            partitionId: 0,
            indexName: INDEX_NAME,
            documentId,
            document: encode({ title: `Novel ${position}` }),
          }),
        )
      }

      await expect(engine.get(INDEX_NAME, ids[2])).resolves.toEqual({ title: 'Novel 2' })
    } finally {
      await engine.shutdown()
    }
  })

  it('refuses an insert into a full partition while the other partitions take writes', async () => {
    const engine = await engineWithLimits({ maxDocsPerPartition: 2 })
    const [first, second, third] = docIdsInPartition(0, 'atlas', 3)
    const [elsewhere] = docIdsInPartition(1, 'atlas', 1)

    try {
      await engine.insert(INDEX_NAME, { title: 'World atlas' }, first)
      await engine.insert(INDEX_NAME, { title: 'Road atlas' }, second)

      await expect(engine.insert(INDEX_NAME, { title: 'Star atlas' }, third)).rejects.toMatchObject({
        code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        details: { partitionId: 0, maxDocsPerPartition: 2 },
      })
      await expect(engine.insert(INDEX_NAME, { title: 'Sea atlas' }, elsewhere)).resolves.toBe(elsewhere)
    } finally {
      await engine.shutdown()
    }
  })

  it('counts the documents that the same batch admits earlier', async () => {
    const engine = await engineWithLimits({ maxDocsPerPartition: 2 })
    const ids = docIdsInPartition(0, 'poem', 3)

    try {
      const result = await engine.insertBatch(
        INDEX_NAME,
        ids.map((id, position) => ({ id, title: `Poem ${position}` })),
      )

      expect(result.succeeded).toEqual(ids.slice(0, 2))
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.error.code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    } finally {
      await engine.shutdown()
    }
  })

  it('emits the watermark for the partition that crosses it', async () => {
    const engine = await engineWithLimits({ maxDocsPerPartition: 4, watermark: 0.5 })
    const events: NarsilEventMap['partitionWatermark'][] = []
    engine.on('partitionWatermark', payload => events.push(payload))
    const [first, second] = docIdsInPartition(0, 'diary', 2)
    const [elsewhere] = docIdsInPartition(1, 'diary', 1)

    try {
      await engine.insert(INDEX_NAME, { title: 'Travel diary' }, first)
      await engine.insert(INDEX_NAME, { title: 'Garden diary' }, elsewhere)
      expect(events).toEqual([])

      await engine.insert(INDEX_NAME, { title: 'War diary' }, second)

      expect(events).toEqual([
        { indexName: INDEX_NAME, documentCount: 2, capacity: 4, partitionCount: PARTITION_COUNT, partitionId: 0 },
      ])
    } finally {
      await engine.shutdown()
    }
  })
})
