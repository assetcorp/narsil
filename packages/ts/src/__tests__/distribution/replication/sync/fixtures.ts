import { decode, encode } from '@msgpack/msgpack'
import { createReplicationLog } from '../../../../distribution/replication/log'
import type { SyncPrimaryDeps } from '../../../../distribution/replication/sync-primary'
import type { SyncReplicaDeps } from '../../../../distribution/replication/sync-replica'
import type { ReplicationLog } from '../../../../distribution/replication/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../../distribution/transport/in-memory'
import type { NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import { createPartitionManager, type PartitionManager } from '../../../../partitioning/manager'
import { createPartitionRouter } from '../../../../partitioning/router'
import type { LanguageModule } from '../../../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../../../types/schema'

export const testLanguage: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are']),
}

export const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
}

export const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

export interface SyncRequestShape {
  indexName: string
  partitionId: number
  lastSeqNo: number
  lastPrimaryTerm: number
}

export function makeManager(indexName: string): PartitionManager {
  return createPartitionManager(indexName, indexConfig, testLanguage, createPartitionRouter(), 1)
}

export function insertDocument(manager: PartitionManager, docId: string, doc: Record<string, unknown>): void {
  manager.insert(docId, doc)
}

export function appendIndexEntry(
  log: ReplicationLog,
  docId: string,
  doc: Record<string, unknown>,
  primaryTerm = 1,
): ReturnType<ReplicationLog['append']> {
  return log.append({
    primaryTerm,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId: docId,
    document: encode(doc),
  })
}

export function appendDeleteEntry(
  log: ReplicationLog,
  docId: string,
  primaryTerm = 1,
): ReturnType<ReplicationLog['append']> {
  return log.append({
    primaryTerm,
    operation: 'DELETE',
    partitionId: 0,
    indexName: 'products',
    documentId: docId,
    document: null,
  })
}

export interface TestCluster {
  network: InMemoryNetwork
  primaryTransport: NodeTransport
  replicaTransport: NodeTransport
  primaryManager: PartitionManager
  replicaManager: PartitionManager
  primaryLog: ReplicationLog
  replicaLog: ReplicationLog
}

export function setupCluster(): TestCluster {
  const network = createInMemoryNetwork()
  const primaryTransport = createInMemoryTransport('primary-node', network)
  const replicaTransport = createInMemoryTransport('replica-node', network)

  const primaryManager = makeManager('products')
  const replicaManager = makeManager('products')

  const primaryLog = createReplicationLog(0)
  const replicaLog = createReplicationLog(0)

  return {
    network,
    primaryTransport,
    replicaTransport,
    primaryManager,
    replicaManager,
    primaryLog,
    replicaLog,
  }
}

export async function teardownCluster(cluster: TestCluster): Promise<void> {
  await cluster.primaryTransport.shutdown()
  await cluster.replicaTransport.shutdown()
}

export function makePrimaryDeps(cluster: TestCluster): SyncPrimaryDeps {
  return {
    log: cluster.primaryLog,
    manager: cluster.primaryManager,
    sourceNodeId: 'primary-node',
    partitionId: 0,
    indexName: 'products',
    primaryTerm: 1,
  }
}

export function makeReplicaDeps(cluster: TestCluster): SyncReplicaDeps {
  return {
    manager: cluster.replicaManager,
    log: cluster.replicaLog,
    transport: cluster.replicaTransport,
    sourceNodeId: 'replica-node',
    partitionId: 0,
    indexName: 'products',
    vectorFieldPaths: new Set(),
    vecIndexes: new Map(),
  }
}

export function makeEvictedLog(): ReplicationLog {
  const log = createReplicationLog(0, { logRetentionBytes: 600 })
  for (let i = 0; i < 50; i++) {
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: `d-${i}`,
      document: new Uint8Array(50),
    })
  }
  return log
}

export function decodeSyncRequest(message: TransportMessage): SyncRequestShape {
  return decode(message.payload) as SyncRequestShape
}
