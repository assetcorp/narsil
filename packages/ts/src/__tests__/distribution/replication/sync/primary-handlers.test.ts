import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createReplicationLog } from '../../../../distribution/replication/log'
import type { SyncPrimaryDeps } from '../../../../distribution/replication/sync-primary'
import {
  decideSyncTier,
  handleSnapshotStream,
  handleSyncRequest,
  validateSyncRequest,
} from '../../../../distribution/replication/sync-primary'
import type {
  SnapshotStartPayload,
  SyncEntriesPayload,
  TransportMessage,
} from '../../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../../distribution/transport/types'
import { appendIndexEntry, insertDocument, makeEvictedLog, makePrimaryDeps, setupCluster } from './fixtures'

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
