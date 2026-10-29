import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createCatchUpState } from '../../../distribution/cluster-node/catch-up/state'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { handlePartitionStores } from '../../../distribution/cluster-node/message-handler/partition-stores'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
import { createSnapshotSyncHandlerState } from '../../../distribution/cluster-node/snapshot-sync-handler'
import { createPartitionWriteQueues } from '../../../distribution/cluster-node/write-routing/partition-queue'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createReplicationLog } from '../../../distribution/replication'
import type { ReplicationLog } from '../../../distribution/replication/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { PartitionStoresResultPayload, TransportMessage } from '../../../distribution/transport/types'
import { ClusterMessageTypes } from '../../../distribution/transport/types'

const INDEX_UUID = '9b3f2c71-08ad-4e55-b1d2-6c7e8f9a0b1c'

function askAbout(indexName: string): TransportMessage {
  return {
    type: ClusterMessageTypes.PARTITION_STORES,
    sourceId: 'controller',
    requestId: 'partition-stores-1',
    payload: encode({ indexName }),
  }
}

async function answerFor(
  engine: ClusterLocalEngine,
  message: TransportMessage,
  copyUnlisted?: (indexName: string, partitionId: number) => boolean,
): Promise<PartitionStoresResultPayload> {
  const coordinator = createInMemoryCoordinator()
  const transport = createInMemoryTransport('node-a', createInMemoryNetwork())
  const logs = new Map<string, ReplicationLog>()
  const deps: DataNodeHandlerDeps = {
    nodeId: 'node-a',
    engine,
    coordinator,
    writeDeps: {
      nodeId: 'node-a',
      coordinator,
      engine,
      transport,
      getReplicationLog: (indexName, partitionId) => {
        const key = `${indexName}:${partitionId}`
        const log = logs.get(key) ?? createReplicationLog(partitionId)
        logs.set(key, log)
        return log
      },
      resetReplicationLog: (indexName, partitionId, startSeqNo, lastPrimaryTerm) => {
        logs.set(`${indexName}:${partitionId}`, createReplicationLog(partitionId, { startSeqNo, lastPrimaryTerm }))
      },
      partitionWriteQueues: createPartitionWriteQueues(),
      catchUp: createCatchUpState(),
      ...(copyUnlisted === undefined ? {} : { copyUnlisted }),
    },
    snapshotSyncState: createSnapshotSyncHandlerState(),
  }
  let answer: PartitionStoresResultPayload | null = null
  try {
    await handlePartitionStores(
      message,
      async response => {
        answer = decode(response.payload) as PartitionStoresResultPayload
      },
      deps,
    )
  } finally {
    await transport.shutdown()
    await coordinator.shutdown()
  }
  if (answer === null) {
    throw new Error('the handler sent no answer')
  }
  return answer
}

describe('a data node answering which partitions its copy holds', () => {
  it('names every partition its copy holds a document for, alongside the index identity', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndexWithUuid(
        'products',
        { schema: { title: 'string' }, partitions: { maxPartitions: 4 } },
        INDEX_UUID,
      )
      await engine.insertBatch(
        'products',
        Array.from({ length: 40 }, (_, index) => ({ title: `bench plane ${index}` })),
      )

      const answer = await answerFor(engine, askAbout('products'))

      expect(answer.indexName).toBe('products')
      expect(answer.indexUuid).toBe(INDEX_UUID)
      expect(answer.partitionIds.length).toBeGreaterThan(0)
      const stats = engine.getPartitionStats('products')
      const holding = stats.filter(partition => partition.documentCount > 0).map(partition => partition.partitionId)
      expect(answer.partitionIds).toEqual(holding)
    } finally {
      await engine.shutdown()
    }
  })

  it('names a partition it was given even where that partition holds no document', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndexWithUuid(
        'products',
        { schema: { title: 'string' }, partitions: { maxPartitions: 4 } },
        INDEX_UUID,
      )
      await engine.recordHeldPartition('products', 2)

      const answer = await answerFor(engine, askAbout('products'))

      expect(answer.partitionIds).toEqual([2])
      expect(engine.getPartitionStats('products').every(partition => partition.documentCount === 0)).toBe(true)
    } finally {
      await engine.shutdown()
    }
  })

  it('leaves out a partition the node gave up', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndexWithUuid(
        'products',
        { schema: { title: 'string' }, partitions: { maxPartitions: 4 } },
        INDEX_UUID,
      )
      await engine.recordHeldPartition('products', 1)
      await engine.recordHeldPartition('products', 3)
      await engine.forgetHeldPartition('products', 1)

      const answer = await answerFor(engine, askAbout('products'))

      expect(answer.partitionIds).toEqual([3])
    } finally {
      await engine.shutdown()
    }
  })

  it('names a partition holding documents even where the record leaves it out', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndexWithUuid(
        'products',
        { schema: { title: 'string' }, partitions: { maxPartitions: 4 } },
        INDEX_UUID,
      )
      await engine.insertBatch(
        'products',
        Array.from({ length: 40 }, (_, index) => ({ title: `bench plane ${index}` })),
      )
      const holding = engine
        .getPartitionStats('products')
        .filter(partition => partition.documentCount > 0)
        .map(partition => partition.partitionId)
      expect(holding.length).toBeGreaterThan(1)
      await engine.recordHeldPartition('products', holding[0])

      const answer = await answerFor(engine, askAbout('products'))

      expect(answer.partitionIds).toEqual(holding)
    } finally {
      await engine.shutdown()
    }
  })

  it('leaves out a partition whose copy failed and has not reloaded, while it names every other one', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndexWithUuid(
        'products',
        { schema: { title: 'string' }, partitions: { maxPartitions: 4 } },
        INDEX_UUID,
      )
      await engine.insertBatch(
        'products',
        Array.from({ length: 40 }, (_, index) => ({ title: `bench plane ${index}` })),
      )
      const holding = engine
        .getPartitionStats('products')
        .filter(partition => partition.documentCount > 0)
        .map(partition => partition.partitionId)
      expect(holding.length).toBeGreaterThan(1)
      const failed = holding[0]

      const answer = await answerFor(
        engine,
        askAbout('products'),
        (indexName, partitionId) => indexName === 'products' && partitionId === failed,
      )

      expect(answer.indexUuid).toBe(INDEX_UUID)
      expect(answer.partitionIds).toEqual(holding.filter(partitionId => partitionId !== failed))
    } finally {
      await engine.shutdown()
    }
  })

  it('answers with a null identity for an index it keeps no copy of', async () => {
    const engine = await createClusterLocalEngine()
    try {
      const answer = await answerFor(engine, askAbout('products'))

      expect(answer).toEqual({ indexName: 'products', indexUuid: null, partitionIds: [] })
    } finally {
      await engine.shutdown()
    }
  })

  it('answers with a null identity for a copy the cluster never stamped', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'bench plane' }, 'doc-1')

      const answer = await answerFor(engine, askAbout('products'))

      expect(answer).toEqual({ indexName: 'products', indexUuid: null, partitionIds: [] })
    } finally {
      await engine.shutdown()
    }
  })

  it('answers a malformed request without naming an index', async () => {
    const engine = await createClusterLocalEngine()
    try {
      const malformed: TransportMessage = {
        type: ClusterMessageTypes.PARTITION_STORES,
        sourceId: 'controller',
        requestId: 'partition-stores-2',
        payload: encode({ indexName: 42 }),
      }

      const answer = await answerFor(engine, malformed)

      expect(answer).toEqual({ indexName: '', indexUuid: null, partitionIds: [] })
    } finally {
      await engine.shutdown()
    }
  })
})
