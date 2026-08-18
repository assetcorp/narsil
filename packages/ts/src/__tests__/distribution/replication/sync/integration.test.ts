import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncPrimaryDeps } from '../../../../distribution/replication/sync-primary'
import { handleSnapshotStream, handleSyncRequest } from '../../../../distribution/replication/sync-primary'
import type { SyncReplicaDeps } from '../../../../distribution/replication/sync-replica'
import { initiateSync } from '../../../../distribution/replication/sync-replica'
import type { TransportMessage } from '../../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../../distribution/transport/types'
import { crc32 } from '../../../../serialization/crc32'
import {
  appendDeleteEntry,
  appendIndexEntry,
  decodeSyncRequest,
  insertDocument,
  makeEvictedLog,
  makePrimaryDeps,
  makeReplicaDeps,
  setupCluster,
  type TestCluster,
  teardownCluster,
} from './fixtures'

describe('sync protocol integration', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    if (cluster !== undefined) {
      await teardownCluster(cluster)
      cluster = undefined
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

    await cluster.primaryTransport.listen(async (message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        await respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      } else if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        await handleSnapshotStream(deps, respond)
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

    await cluster.primaryTransport.listen(async (message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        await respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      } else if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        await handleSnapshotStream(deps, respond)
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

  it('Tier 2: rejects a snapshot whose end checksum disagrees with the header', async () => {
    cluster = setupCluster()

    const primaryLog = makeEvictedLog()
    insertDocument(cluster.primaryManager, 'prod-corrupt', { title: 'Damaged', body: 'In flight', price: 3 })

    const deps: SyncPrimaryDeps = {
      log: primaryLog,
      manager: cluster.primaryManager,
      sourceNodeId: 'primary-node',
      partitionId: 0,
      indexName: 'products',
      primaryTerm: 1,
    }

    const realBytes = cluster.primaryManager.serializePartitionToBytes(0)
    const corruptedBytes = realBytes.slice()
    corruptedBytes[Math.floor(corruptedBytes.length / 2)] ^= 0xff

    await cluster.primaryTransport.listen(async (message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        await respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
      } else if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        await handleSnapshotStream(deps, respond, corruptedBytes)
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(false)
    expect(result.tier).toBe('snapshot')
    expect(result.error?.code).toBe('REPLICATION_SYNC_FAILED')
    expect(cluster.replicaManager.has('prod-corrupt')).toBe(false)
  })

  it('Tier 2: rejects corrupted snapshot bytes with REPLICATION_SNAPSHOT_CORRUPT', async () => {
    cluster = setupCluster()

    const primaryLog = makeEvictedLog()
    insertDocument(cluster.primaryManager, 'prod-flip', { title: 'Flipped', body: 'One bad byte', price: 9 })

    const deps: SyncPrimaryDeps = {
      log: primaryLog,
      manager: cluster.primaryManager,
      sourceNodeId: 'primary-node',
      partitionId: 0,
      indexName: 'products',
      primaryTerm: 1,
    }

    const realBytes = cluster.primaryManager.serializePartitionToBytes(0)
    const realChecksum = crc32(realBytes)
    const corruptedBytes = realBytes.slice()
    corruptedBytes[Math.floor(corruptedBytes.length / 2)] ^= 0xff

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.SYNC_REQUEST) {
        respond(handleSyncRequest(decodeSyncRequest(message), deps).response)
        return
      }
      if (message.type === ReplicationMessageTypes.SNAPSHOT_CHUNK) {
        respond({
          type: ReplicationMessageTypes.SNAPSHOT_CHUNK,
          sourceId: 'primary-node',
          requestId: message.requestId,
          payload: encode({ partitionId: 0, indexName: 'products', offset: 0, data: corruptedBytes }),
        })
        respond({
          type: ReplicationMessageTypes.SNAPSHOT_END,
          sourceId: 'primary-node',
          requestId: message.requestId,
          payload: encode({
            partitionId: 0,
            indexName: 'products',
            totalBytes: corruptedBytes.byteLength,
            checksum: realChecksum,
          }),
        })
      }
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(false)
    expect(result.tier).toBe('snapshot')
    expect(result.error?.code).toBe('REPLICATION_SNAPSHOT_CORRUPT')
    expect(cluster.replicaManager.has('prod-flip')).toBe(false)
  })

  it('reports REPLICATION_SYNC_FAILED for an unexpected response type', async () => {
    cluster = setupCluster()

    await cluster.primaryTransport.listen((message: TransportMessage, respond) => {
      respond({
        type: ReplicationMessageTypes.ACK,
        sourceId: 'primary-node',
        requestId: message.requestId,
        payload: message.payload,
      })
    })

    const replicaDeps = makeReplicaDeps(cluster)
    const result = await initiateSync('primary-node', 0, 1, replicaDeps)

    expect(result.synced).toBe(false)
    expect(result.tier).toBe('none')
    expect(result.error?.code).toBe('REPLICATION_SYNC_FAILED')
  })
})
