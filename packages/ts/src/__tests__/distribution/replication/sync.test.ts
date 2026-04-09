import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplicationLog } from '../../../distribution/replication/log'
import type { SyncPrimaryDeps } from '../../../distribution/replication/sync-primary'
import {
  decideSyncTier,
  handleSnapshotStream,
  handleSyncRequest,
  validateSyncRequest,
} from '../../../distribution/replication/sync-primary'
import type { SyncReplicaDeps } from '../../../distribution/replication/sync-replica'
import { initiateSync } from '../../../distribution/replication/sync-replica'
import type { ReplicationLog } from '../../../distribution/replication/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import type {
  NodeTransport,
  SnapshotStartPayload,
  SyncEntriesPayload,
  TransportMessage,
} from '../../../distribution/transport/types'
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

interface SyncRequestShape {
  indexName: string
  partitionId: number
  lastSeqNo: number
  lastPrimaryTerm: number
}

function makeManager(indexName: string): PartitionManager {
  return createPartitionManager(indexName, indexConfig, testLanguage, createPartitionRouter(), 1)
}

function insertDocument(manager: PartitionManager, docId: string, doc: Record<string, unknown>): void {
  manager.insert(docId, doc)
}

function appendIndexEntry(
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

function appendDeleteEntry(log: ReplicationLog, docId: string, primaryTerm = 1): ReturnType<ReplicationLog['append']> {
  return log.append({
    primaryTerm,
    operation: 'DELETE',
    partitionId: 0,
    indexName: 'products',
    documentId: docId,
    document: null,
  })
}

interface TestCluster {
  network: InMemoryNetwork
  primaryTransport: NodeTransport
  replicaTransport: NodeTransport
  primaryManager: PartitionManager
  replicaManager: PartitionManager
  primaryLog: ReplicationLog
  replicaLog: ReplicationLog
}

function setupCluster(): TestCluster {
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

async function teardownCluster(cluster: TestCluster): Promise<void> {
  await cluster.primaryTransport.shutdown()
  await cluster.replicaTransport.shutdown()
}

function makePrimaryDeps(cluster: TestCluster): SyncPrimaryDeps {
  return {
    log: cluster.primaryLog,
    manager: cluster.primaryManager,
    sourceNodeId: 'primary-node',
    partitionId: 0,
    indexName: 'products',
    primaryTerm: 1,
  }
}

function makeReplicaDeps(cluster: TestCluster): SyncReplicaDeps {
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

function makeEvictedLog(): ReplicationLog {
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

function decodeSyncRequest(message: TransportMessage): SyncRequestShape {
  return decode(message.payload) as SyncRequestShape
}

describe('decideSyncTier', () => {
  it('returns incremental when log covers the gap', () => {
    const log = createReplicationLog(0)
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'd1',
      document: encode({ title: 'A' }),
    })
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'd2',
      document: encode({ title: 'B' }),
    })

    expect(decideSyncTier(log, 0)).toBe('incremental')
    expect(decideSyncTier(log, 1)).toBe('incremental')
  })

  it('returns snapshot when log does not cover the gap', () => {
    const log = makeEvictedLog()
    const oldest = log.oldestSeqNo
    expect(oldest).toBeDefined()
    expect(oldest).toBeGreaterThan(1)
    expect(decideSyncTier(log, 0)).toBe('snapshot')
  })

  it('returns incremental for empty log when replica is at seqNo 0', () => {
    const log = createReplicationLog(0)
    expect(decideSyncTier(log, 0)).toBe('incremental')
  })

  it('returns snapshot for empty log when replica has a nonzero lastSeqNo', () => {
    const log = createReplicationLog(0)
    expect(decideSyncTier(log, 5)).toBe('snapshot')
  })

  it('returns incremental when replica is at the exact boundary', () => {
    const log = createReplicationLog(0, { startSeqNo: 5 })
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'd1',
      document: encode({ title: 'A' }),
    })

    expect(decideSyncTier(log, 4)).toBe('incremental')
    expect(decideSyncTier(log, 5)).toBe('incremental')
  })
})

describe('handleSyncRequest', () => {
  it('returns sync_entries for incremental tier', () => {
    const cluster = setupCluster()
    const deps = makePrimaryDeps(cluster)
    const doc = { title: 'Widget', body: 'A fine widget', price: 25 }
    insertDocument(cluster.primaryManager, 'prod-1', doc)
    appendIndexEntry(cluster.primaryLog, 'prod-1', doc)

    const { response, snapshotBytes } = handleSyncRequest(
      { indexName: 'products', partitionId: 0, lastSeqNo: 0, lastPrimaryTerm: 1 },
      deps,
    )

    expect(snapshotBytes).toBeNull()
    expect(response.type).toBe(ReplicationMessageTypes.SYNC_ENTRIES)
    const payload = decode(response.payload) as SyncEntriesPayload
    expect(payload.entries).toHaveLength(1)
    expect(payload.isLast).toBe(true)
    expect(payload.entries[0].documentId).toBe('prod-1')
  })

  it('returns snapshot_start for snapshot tier', () => {
    const cluster = setupCluster()
    const doc = { title: 'Widget', body: 'A fine widget', price: 25 }
    insertDocument(cluster.primaryManager, 'prod-1', doc)

    const log = makeEvictedLog()
    const deps: SyncPrimaryDeps = {
      log,
      manager: cluster.primaryManager,
      sourceNodeId: 'primary-node',
      partitionId: 0,
      indexName: 'products',
      primaryTerm: 1,
    }

    const { response, snapshotBytes } = handleSyncRequest(
      { indexName: 'products', partitionId: 0, lastSeqNo: 0, lastPrimaryTerm: 1 },
      deps,
    )

    expect(snapshotBytes).not.toBeNull()
    expect(response.type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
    const payload = decode(response.payload) as SnapshotStartPayload
    expect(payload.header.partitionId).toBe(0)
    expect(payload.header.indexName).toBe('products')
    expect(payload.totalBytes).toBeGreaterThan(0)
    expect(payload.header.checksum).toBeGreaterThanOrEqual(0)
  })

  it('returns empty entries when replica is already caught up', () => {
    const cluster = setupCluster()
    const doc = { title: 'Widget', body: 'A fine widget', price: 25 }
    insertDocument(cluster.primaryManager, 'prod-1', doc)
    appendIndexEntry(cluster.primaryLog, 'prod-1', doc)

    const deps = makePrimaryDeps(cluster)
    const { response } = handleSyncRequest(
      { indexName: 'products', partitionId: 0, lastSeqNo: 1, lastPrimaryTerm: 1 },
      deps,
    )

    expect(response.type).toBe(ReplicationMessageTypes.SYNC_ENTRIES)
    const payload = decode(response.payload) as SyncEntriesPayload
    expect(payload.entries).toHaveLength(0)
    expect(payload.isLast).toBe(true)
  })

  it('returns only the entries the replica has missed', () => {
    const cluster = setupCluster()
    const deps = makePrimaryDeps(cluster)

    for (let i = 0; i < 10; i++) {
      const doc = { title: `Product ${i}`, body: `Desc ${i}`, price: i * 10 }
      insertDocument(cluster.primaryManager, `prod-${i}`, doc)
      appendIndexEntry(cluster.primaryLog, `prod-${i}`, doc)
    }

    const { response } = handleSyncRequest(
      { indexName: 'products', partitionId: 0, lastSeqNo: 5, lastPrimaryTerm: 1 },
      deps,
    )

    expect(response.type).toBe(ReplicationMessageTypes.SYNC_ENTRIES)
    const payload = decode(response.payload) as SyncEntriesPayload
    expect(payload.entries).toHaveLength(5)
    expect(payload.entries[0].seqNo).toBe(6)
    expect(payload.entries[4].seqNo).toBe(10)
  })
})

describe('handleSnapshotStream', () => {
  it('produces snapshot chunks and a snapshot_end message', () => {
    const cluster = setupCluster()
    const doc = { title: 'Streaming Widget', body: 'Sent as snapshot', price: 42 }
    insertDocument(cluster.primaryManager, 'prod-snap', doc)
    appendIndexEntry(cluster.primaryLog, 'prod-snap', doc)

    const deps = makePrimaryDeps(cluster)
    const responses: TransportMessage[] = []

    handleSnapshotStream(deps, msg => responses.push(msg))

    const chunkMessages = responses.filter(r => r.type === ReplicationMessageTypes.SNAPSHOT_CHUNK)
    const endMessages = responses.filter(r => r.type === ReplicationMessageTypes.SNAPSHOT_END)

    expect(chunkMessages.length).toBeGreaterThanOrEqual(1)
    expect(endMessages).toHaveLength(1)
  })
})

describe('validateSyncRequest', () => {
  it('validates a correct payload', () => {
    const result = validateSyncRequest({
      indexName: 'products',
      partitionId: 0,
      lastSeqNo: 5,
      lastPrimaryTerm: 1,
    })
    expect(result.indexName).toBe('products')
    expect(result.lastSeqNo).toBe(5)
  })

  it('throws for non-object input', () => {
    expect(() => validateSyncRequest(null)).toThrow('expected an object')
    expect(() => validateSyncRequest('string')).toThrow('expected an object')
    expect(() => validateSyncRequest([])).toThrow('expected an object')
  })

  it('throws for missing fields', () => {
    expect(() => validateSyncRequest({})).toThrow('"indexName" must be a string')
    expect(() => validateSyncRequest({ indexName: 'x' })).toThrow('"partitionId" must be a non-negative integer')
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0 })).toThrow(
      '"lastSeqNo" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: 0 })).toThrow(
      '"lastPrimaryTerm" must be a non-negative integer',
    )
  })

  it('rejects NaN values for numeric fields', () => {
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: NaN, lastSeqNo: 0, lastPrimaryTerm: 0 })).toThrow(
      '"partitionId" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: NaN, lastPrimaryTerm: 0 })).toThrow(
      '"lastSeqNo" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: 0, lastPrimaryTerm: NaN })).toThrow(
      '"lastPrimaryTerm" must be a non-negative integer',
    )
  })

  it('rejects negative values for numeric fields', () => {
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: -1, lastSeqNo: 0, lastPrimaryTerm: 0 })).toThrow(
      '"partitionId" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: -5, lastPrimaryTerm: 0 })).toThrow(
      '"lastSeqNo" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: 0, lastPrimaryTerm: -1 })).toThrow(
      '"lastPrimaryTerm" must be a non-negative integer',
    )
  })

  it('rejects non-integer values for numeric fields', () => {
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 1.5, lastSeqNo: 0, lastPrimaryTerm: 0 })).toThrow(
      '"partitionId" must be a non-negative integer',
    )
    expect(() => validateSyncRequest({ indexName: 'x', partitionId: 0, lastSeqNo: 2.7, lastPrimaryTerm: 0 })).toThrow(
      '"lastSeqNo" must be a non-negative integer',
    )
  })
})

describe('sync protocol integration', () => {
  let cluster: TestCluster

  afterEach(async () => {
    if (cluster) {
      await teardownCluster(cluster)
    }
  })

  it('Tier 1: replica catches up via incremental sync', async () => {
    cluster = setupCluster()
    const deps = makePrimaryDeps(cluster)

    for (let i = 0; i < 5; i++) {
      const doc = { title: `Product ${i}`, body: `Description ${i}`, price: (i + 1) * 10 }
      insertDocument(cluster.primaryManager, `prod-${i}`, doc)
      appendIndexEntry(cluster.primaryLog, `prod-${i}`, doc)
    }

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.tier).toBe('incremental')
    expect(result.entriesApplied).toBe(5)
    expect(result.newSeqNo).toBe(5)

    for (let i = 0; i < 5; i++) {
      expect(cluster.replicaManager.has(`prod-${i}`)).toBe(true)
    }
  })

  it('Tier 1: replica catches up from a partial position', async () => {
    cluster = setupCluster()

    for (let i = 0; i < 10; i++) {
      const doc = { title: `Product ${i}`, body: `Description ${i}`, price: (i + 1) * 10 }
      insertDocument(cluster.primaryManager, `prod-${i}`, doc)
      appendIndexEntry(cluster.primaryLog, `prod-${i}`, doc)
    }

    for (let i = 0; i < 5; i++) {
      const doc = { title: `Product ${i}`, body: `Description ${i}`, price: (i + 1) * 10 }
      insertDocument(cluster.replicaManager, `prod-${i}`, doc)
      appendIndexEntry(cluster.replicaLog, `prod-${i}`, doc)
    }

    const deps = makePrimaryDeps(cluster)
    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 5, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.tier).toBe('incremental')
    expect(result.entriesApplied).toBe(5)
    expect(result.newSeqNo).toBe(10)

    for (let i = 0; i < 10; i++) {
      expect(cluster.replicaManager.has(`prod-${i}`)).toBe(true)
    }
  })

  it('Tier 1: replica already caught up returns zero entries', async () => {
    cluster = setupCluster()

    const doc = { title: 'Only Product', body: 'Already synced', price: 99 }
    insertDocument(cluster.primaryManager, 'prod-0', doc)
    appendIndexEntry(cluster.primaryLog, 'prod-0', doc)

    insertDocument(cluster.replicaManager, 'prod-0', doc)
    appendIndexEntry(cluster.replicaLog, 'prod-0', doc)

    const deps = makePrimaryDeps(cluster)
    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 1, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.tier).toBe('incremental')
    expect(result.entriesApplied).toBe(0)
    expect(result.newSeqNo).toBe(1)
  })

  it('Tier 2: replica receives full snapshot when log does not cover the gap', async () => {
    cluster = setupCluster()

    const primaryLog = makeEvictedLog()

    for (let i = 0; i < 3; i++) {
      const doc = { title: `Product ${i}`, body: `Description ${i}`, price: (i + 1) * 10 }
      insertDocument(cluster.primaryManager, `prod-${i}`, doc)
    }

    const deps: SyncPrimaryDeps = {
      log: primaryLog,
      manager: cluster.primaryManager,
      sourceNodeId: 'primary-node',
      partitionId: 0,
      indexName: 'products',
      primaryTerm: 1,
    }

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      } else if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        handleSnapshotStream(deps, respond)
      }
    })

    const replicaDeps: SyncReplicaDeps = {
      manager: cluster.replicaManager,
      log: cluster.replicaLog,
      transport: cluster.replicaTransport,
      sourceNodeId: 'replica-node',
      partitionId: 0,
      indexName: 'products',
      vectorFieldPaths: new Set(),
      vecIndexes: new Map(),
    }

    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.tier).toBe('snapshot')

    for (let i = 0; i < 3; i++) {
      expect(cluster.replicaManager.has(`prod-${i}`)).toBe(true)
    }
  })

  it('Tier 2: snapshot checksum is verified on the replica', async () => {
    cluster = setupCluster()

    const primaryLog = makeEvictedLog()

    const doc = { title: 'Checksummed', body: 'Integrity verified', price: 77 }
    insertDocument(cluster.primaryManager, 'prod-check', doc)

    const deps: SyncPrimaryDeps = {
      log: primaryLog,
      manager: cluster.primaryManager,
      sourceNodeId: 'primary-node',
      partitionId: 0,
      indexName: 'products',
      primaryTerm: 1,
    }

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      } else if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        handleSnapshotStream(deps, respond)
      }
    })

    const replicaDeps: SyncReplicaDeps = {
      manager: cluster.replicaManager,
      log: cluster.replicaLog,
      transport: cluster.replicaTransport,
      sourceNodeId: 'replica-node',
      partitionId: 0,
      indexName: 'products',
      vectorFieldPaths: new Set(),
      vecIndexes: new Map(),
    }

    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(cluster.replicaManager.has('prod-check')).toBe(true)
    const replicaDoc = cluster.replicaManager.get('prod-check') as Record<string, unknown>
    expect(replicaDoc.title).toBe('Checksummed')
  })

  it('Tier 1: handles exactly one missed entry', async () => {
    cluster = setupCluster()
    const deps = makePrimaryDeps(cluster)

    const doc1 = { title: 'First', body: 'Already replicated', price: 10 }
    insertDocument(cluster.primaryManager, 'prod-0', doc1)
    appendIndexEntry(cluster.primaryLog, 'prod-0', doc1)

    insertDocument(cluster.replicaManager, 'prod-0', doc1)
    appendIndexEntry(cluster.replicaLog, 'prod-0', doc1)

    const doc2 = { title: 'Second', body: 'The missed one', price: 20 }
    insertDocument(cluster.primaryManager, 'prod-1', doc2)
    appendIndexEntry(cluster.primaryLog, 'prod-1', doc2)

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 1, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.entriesApplied).toBe(1)
    expect(result.newSeqNo).toBe(2)
    expect(cluster.replicaManager.has('prod-1')).toBe(true)
  })

  it('Tier 1: applies both INDEX and DELETE entries during sync', async () => {
    cluster = setupCluster()
    const deps = makePrimaryDeps(cluster)

    const doc = { title: 'Ephemeral', body: 'Will be deleted', price: 5 }
    insertDocument(cluster.primaryManager, 'prod-del', doc)
    appendIndexEntry(cluster.primaryLog, 'prod-del', doc)

    cluster.primaryManager.remove('prod-del')
    appendDeleteEntry(cluster.primaryLog, 'prod-del')

    const doc2 = { title: 'Keeper', body: 'This stays', price: 50 }
    insertDocument(cluster.primaryManager, 'prod-keep', doc2)
    appendIndexEntry(cluster.primaryLog, 'prod-keep', doc2)

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(true)
    expect(result.entriesApplied).toBe(3)
    expect(cluster.replicaManager.has('prod-del')).toBe(false)
    expect(cluster.replicaManager.has('prod-keep')).toBe(true)
  })
})
