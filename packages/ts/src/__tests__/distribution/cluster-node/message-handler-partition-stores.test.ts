import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { handlePartitionStores } from '../../../distribution/cluster-node/message-handler/partition-stores'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
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

async function answerFor(engine: ClusterLocalEngine, message: TransportMessage): Promise<PartitionStoresResultPayload> {
  const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
  let answer: PartitionStoresResultPayload | null = null
  await handlePartitionStores(
    message,
    async response => {
      answer = decode(response.payload) as PartitionStoresResultPayload
    },
    deps,
  )
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
