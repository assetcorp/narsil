import { describe, expect, it } from 'vitest'
import { createReplicationLog, DEFAULT_LOG_RETENTION_BYTES } from '../../../../distribution/replication'
import { makeDeleteEntry, makeIndexEntry } from './fixtures'

describe('ReplicationLog retention eviction', () => {
  it('evicts oldest entries when sizeBytes exceeds retention', () => {
    const log = createReplicationLog(0, { logRetentionBytes: 200 })
    for (let i = 0; i < 20; i++) {
      log.append(
        makeIndexEntry({
          documentId: `doc-${i}`,
          document: new Uint8Array(50),
        }),
      )
    }
    expect(log.entryCount).toBeLessThan(20)
    expect(log.sizeBytes).toBeLessThanOrEqual(200)
  })

  it('preserves newest entries during eviction', () => {
    const log = createReplicationLog(0, { logRetentionBytes: 200 })
    for (let i = 0; i < 20; i++) {
      log.append(
        makeIndexEntry({
          documentId: `doc-${i}`,
          document: new Uint8Array(50),
        }),
      )
    }
    const newest = log.newestSeqNo
    expect(newest).toBe(20)
    const oldestEntry = log.getEntry(log.oldestSeqNo ?? 0)
    expect(oldestEntry).toBeDefined()
  })

  it('shifts oldestSeqNo forward as entries are evicted', () => {
    const log = createReplicationLog(0, { logRetentionBytes: 200 })
    log.append(makeIndexEntry({ documentId: 'doc-0', document: new Uint8Array(100) }))
    const firstOldest = log.oldestSeqNo
    expect(firstOldest).toBe(1)

    for (let i = 1; i < 10; i++) {
      log.append(makeIndexEntry({ documentId: `doc-${i}`, document: new Uint8Array(100) }))
    }

    const laterOldest = log.oldestSeqNo ?? 0
    expect(laterOldest).toBeGreaterThan(1)
  })

  it('tracks sizeBytes correctly as entries are added and evicted', () => {
    const log = createReplicationLog(0, { logRetentionBytes: 500 })
    for (let i = 0; i < 5; i++) {
      log.append(
        makeIndexEntry({
          documentId: `doc-${i}`,
          document: new Uint8Array(80),
        }),
      )
    }
    const sizeAfterFive = log.sizeBytes
    expect(sizeAfterFive).toBeGreaterThan(0)

    for (let i = 5; i < 20; i++) {
      log.append(
        makeIndexEntry({
          documentId: `doc-${i}`,
          document: new Uint8Array(80),
        }),
      )
    }
    expect(log.sizeBytes).toBeLessThanOrEqual(500)
    expect(log.sizeBytes).toBeGreaterThan(0)
  })
})

describe('ReplicationLog clear', () => {
  it('empties the log', () => {
    const log = createReplicationLog(0)
    log.append(makeIndexEntry({ documentId: 'doc-001' }))
    log.append(makeIndexEntry({ documentId: 'doc-002' }))
    log.clear()

    expect(log.entryCount).toBe(0)
    expect(log.sizeBytes).toBe(0)
    expect(log.oldestSeqNo).toBeUndefined()
    expect(log.newestSeqNo).toBeUndefined()
    expect(log.getEntriesFrom(1)).toEqual([])
  })

  it('does not reset seqNo counter (per spec)', () => {
    const log = createReplicationLog(0)
    log.append(makeIndexEntry({ documentId: 'doc-001' }))
    log.append(makeIndexEntry({ documentId: 'doc-002' }))
    log.clear()

    const entry = log.append(makeIndexEntry({ documentId: 'doc-003' }))
    expect(entry.seqNo).toBe(3)
  })
})

describe('ReplicationLog default config', () => {
  it('uses 256 MB as the default retention', () => {
    expect(DEFAULT_LOG_RETENTION_BYTES).toBe(268_435_456)
  })
})

describe('ReplicationLog mixed operations', () => {
  it('handles interleaved INDEX and DELETE operations', () => {
    const log = createReplicationLog(0)
    const idx1 = log.append(makeIndexEntry({ documentId: 'doc-001' }))
    const del1 = log.append(makeDeleteEntry({ documentId: 'doc-001' }))
    const idx2 = log.append(makeIndexEntry({ documentId: 'doc-002' }))

    expect(idx1.operation).toBe('INDEX')
    expect(del1.operation).toBe('DELETE')
    expect(del1.document).toBeNull()
    expect(idx2.operation).toBe('INDEX')

    expect(log.verifyChecksum(idx1)).toBe(true)
    expect(log.verifyChecksum(del1)).toBe(true)
    expect(log.verifyChecksum(idx2)).toBe(true)

    const entries = log.getEntriesFrom(1)
    expect(entries).toHaveLength(3)
  })
})

describe('ReplicationLog different partitions', () => {
  it('creates independent logs for different partitions', () => {
    const log0 = createReplicationLog(0)
    const log1 = createReplicationLog(1)

    const entry0 = log0.append(makeIndexEntry({ partitionId: 0 }))
    const entry1 = log1.append(makeIndexEntry({ partitionId: 1 }))

    expect(entry0.seqNo).toBe(1)
    expect(entry1.seqNo).toBe(1)
    expect(log0.entryCount).toBe(1)
    expect(log1.entryCount).toBe(1)
  })
})
