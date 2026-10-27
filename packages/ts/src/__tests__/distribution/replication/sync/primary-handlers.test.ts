import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createReplicationLog } from '../../../../distribution/replication/log'
import { decideSyncTier, validateSyncRequest } from '../../../../distribution/replication/sync-primary'

function makeEvictedLog() {
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

    expect(decideSyncTier(log, 0, 0)).toBe('incremental')
    expect(decideSyncTier(log, 1, 1)).toBe('incremental')
  })

  it('returns snapshot when the entry at the replica position carries another term', () => {
    const log = createReplicationLog(0)
    log.append({
      primaryTerm: 2,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'd1',
      document: encode({ title: 'A' }),
    })

    expect(decideSyncTier(log, 1, 1)).toBe('snapshot')
    expect(decideSyncTier(log, 1, 2)).toBe('incremental')
  })

  it('returns snapshot when log does not cover the gap', () => {
    const log = makeEvictedLog()
    const oldest = log.oldestSeqNo
    expect(oldest).toBeDefined()
    expect(oldest).toBeGreaterThan(1)
    expect(decideSyncTier(log, 0, 0)).toBe('snapshot')
    expect(decideSyncTier(log, (oldest ?? 2) - 1, 1)).toBe('snapshot')
  })

  it('returns incremental for empty log when replica is at seqNo 0', () => {
    const log = createReplicationLog(0)
    expect(decideSyncTier(log, 0, 0)).toBe('incremental')
  })

  it('returns snapshot for empty log when replica has a nonzero lastSeqNo', () => {
    const log = createReplicationLog(0)
    expect(decideSyncTier(log, 5, 1)).toBe('snapshot')
  })

  it('returns incremental when replica is at the position the log started from with the same term', () => {
    const log = createReplicationLog(0, { startSeqNo: 5, lastPrimaryTerm: 1 })
    log.append({
      primaryTerm: 2,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'd1',
      document: encode({ title: 'A' }),
    })

    expect(decideSyncTier(log, 4, 1)).toBe('incremental')
    expect(decideSyncTier(log, 4, 2)).toBe('snapshot')
    expect(decideSyncTier(log, 5, 2)).toBe('incremental')
    expect(decideSyncTier(log, 3, 1)).toBe('snapshot')
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
