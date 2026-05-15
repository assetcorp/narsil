import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createAckMessage, validateEntryPayload } from '../../../distribution/replication/codec'
import { createReplicationLog } from '../../../distribution/replication/log'
import { replicateToReplicas } from '../../../distribution/replication/primary'
import { applyDeleteEntry, applyIndexEntry, validateReplicationEntry } from '../../../distribution/replication/replica'
import type { ReplicationLog } from '../../../distribution/replication/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../../types/schema'

const testLanguage: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are']),
}

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

function makeManager(indexName: string): PartitionManager {
  return createPartitionManager(indexName, indexConfig, testLanguage, createPartitionRouter(), 1)
}

function makeAllocationTable(): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: ['node-b'],
    state: 'ACTIVE',
    primaryTerm: 1,
  }

  return {
    indexName: 'products',
    version: 1,
    replicationFactor: 2,
    assignments: new Map([[0, assignment]]),
  }
}

interface TestCluster {
  coordinator: ClusterCoordinator
  network: InMemoryNetwork
  primaryTransport: NodeTransport
  replicaTransport: NodeTransport
  primaryManager: PartitionManager
  replicaManager: PartitionManager
  primaryLog: ReplicationLog
  replicaLog: ReplicationLog
}

async function setupCluster(): Promise<TestCluster> {
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const primaryTransport = createInMemoryTransport('node-a', network)
  const replicaTransport = createInMemoryTransport('node-b', network)

  const primaryManager = makeManager('products')
  const replicaManager = makeManager('products')

  const primaryLog = createReplicationLog(0)
  const replicaLog = createReplicationLog(0)

  await coordinator.putAllocation('products', makeAllocationTable())

  await replicaTransport.listen((message: TransportMessage, respond) => {
    if (message.type === ReplicationMessageTypes.ENTRY) {
      const payload = validateEntryPayload(decode(message.payload))
      const entry = payload.entry
      const validation = validateReplicationEntry(entry, 1, primaryLog)

      if (validation.valid) {
        replicaLog.append({
          primaryTerm: entry.primaryTerm,
          operation: entry.operation,
          partitionId: entry.partitionId,
          indexName: entry.indexName,
          documentId: entry.documentId,
          document: entry.document,
        })

        if (entry.operation === 'INDEX') {
          applyIndexEntry(entry, replicaManager, new Set(), new Map())
        } else {
          applyDeleteEntry(entry, replicaManager, new Map())
        }

        respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, 'node-b', message.requestId))
      }
    }
  })

  return {
    coordinator,
    network,
    primaryTransport,
    replicaTransport,
    primaryManager,
    replicaManager,
    primaryLog,
    replicaLog,
  }
}

async function teardownCluster(cluster: TestCluster): Promise<void> {
  await cluster.primaryTransport.shutdown()
  await cluster.replicaTransport.shutdown()
  await cluster.coordinator.shutdown()
}

describe('multi-node replication integration', () => {
  let cluster: TestCluster

  afterEach(async () => {
    if (cluster) {
      await teardownCluster(cluster)
    }
  })

  it('replicates an INDEX entry from primary to replica', async () => {
    cluster = await setupCluster()

    const document = { title: 'Noise Cancelling Earbuds', body: 'Premium sound quality', price: 199 }
    const encodedDoc = encode(document)

    const entry = cluster.primaryLog.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-001',
      document: encodedDoc,
    })

    cluster.primaryManager.insert('prod-001', document)

    const result = await replicateToReplicas(entry, ['node-b'], cluster.primaryTransport, 'node-a')

    expect(result.acknowledged).toEqual(['node-b'])
    expect(result.failed).toEqual([])

    expect(cluster.primaryManager.has('prod-001')).toBe(true)
    expect(cluster.replicaManager.has('prod-001')).toBe(true)

    const replicaDoc = cluster.replicaManager.get('prod-001') as Record<string, unknown>
    expect(replicaDoc.title).toBe('Noise Cancelling Earbuds')
    expect(replicaDoc.price).toBe(199)
  })

  it('replicates a DELETE entry, removing the document from the replica', async () => {
    cluster = await setupCluster()

    const document = { title: 'Temporary Item', body: 'To be deleted', price: 50 }
    const encodedDoc = encode(document)

    const indexEntry = cluster.primaryLog.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-temp',
      document: encodedDoc,
    })

    cluster.primaryManager.insert('prod-temp', document)
    await replicateToReplicas(indexEntry, ['node-b'], cluster.primaryTransport, 'node-a')

    expect(cluster.replicaManager.has('prod-temp')).toBe(true)

    const deleteEntry = cluster.primaryLog.append({
      primaryTerm: 1,
      operation: 'DELETE',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-temp',
      document: null,
    })

    cluster.primaryManager.remove('prod-temp')
    const deleteResult = await replicateToReplicas(deleteEntry, ['node-b'], cluster.primaryTransport, 'node-a')

    expect(deleteResult.acknowledged).toEqual(['node-b'])
    expect(cluster.primaryManager.has('prod-temp')).toBe(false)
    expect(cluster.replicaManager.has('prod-temp')).toBe(false)
  })

  it('reports failure when replica transport is shut down', async () => {
    cluster = await setupCluster()

    const document = { title: 'Unreachable Item', body: 'Will not replicate', price: 10 }
    const encodedDoc = encode(document)

    const entry = cluster.primaryLog.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-unreachable',
      document: encodedDoc,
    })

    await cluster.replicaTransport.shutdown()

    const result = await replicateToReplicas(entry, ['node-b'], cluster.primaryTransport, 'node-a')

    expect(result.acknowledged).toEqual([])
    expect(result.failed).toEqual(['node-b'])
  })

  it('replicates multiple entries in sequence', async () => {
    cluster = await setupCluster()

    for (let i = 0; i < 5; i++) {
      const document = { title: `Product ${i}`, body: `Description for product ${i}`, price: 10 * (i + 1) }
      const encodedDoc = encode(document)

      const entry = cluster.primaryLog.append({
        primaryTerm: 1,
        operation: 'INDEX',
        partitionId: 0,
        indexName: 'products',
        documentId: `prod-${i}`,
        document: encodedDoc,
      })

      cluster.primaryManager.insert(`prod-${i}`, document)
      const result = await replicateToReplicas(entry, ['node-b'], cluster.primaryTransport, 'node-a')
      expect(result.acknowledged).toEqual(['node-b'])
    }

    expect(cluster.primaryManager.countDocuments()).toBe(5)
    expect(cluster.replicaManager.countDocuments()).toBe(5)

    for (let i = 0; i < 5; i++) {
      expect(cluster.replicaManager.has(`prod-${i}`)).toBe(true)
    }
  })
})
