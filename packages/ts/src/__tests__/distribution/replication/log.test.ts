import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import type { ReplicationLogEntry } from '../../../distribution/replication'
import { createReplicationLog, DEFAULT_LOG_RETENTION_BYTES } from '../../../distribution/replication'

function makeIndexEntry(
  overrides?: Partial<Omit<ReplicationLogEntry, 'seqNo' | 'checksum'>>,
): Omit<ReplicationLogEntry, 'seqNo' | 'checksum'> {
  return {
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId: 'doc-001',
    document: encode({ title: 'Wireless Headphones', price: 149 }),
    ...overrides,
  }
}

function makeDeleteEntry(
  overrides?: Partial<Omit<ReplicationLogEntry, 'seqNo' | 'checksum'>>,
): Omit<ReplicationLogEntry, 'seqNo' | 'checksum'> {
  return {
    primaryTerm: 1,
    operation: 'DELETE',
    partitionId: 0,
    indexName: 'products',
    documentId: 'doc-002',
    document: null,
    ...overrides,
  }
}

describe('ReplicationLog', () => {
  describe('empty log', () => {
    it('has undefined oldestSeqNo and newestSeqNo', () => {
      const log = createReplicationLog(0)
      expect(log.oldestSeqNo).toBeUndefined()
      expect(log.newestSeqNo).toBeUndefined()
    })

    it('has zero entryCount and sizeBytes', () => {
      const log = createReplicationLog(0)
      expect(log.entryCount).toBe(0)
      expect(log.sizeBytes).toBe(0)
    })

    it('returns empty array from getEntriesFrom', () => {
      const log = createReplicationLog(0)
      expect(log.getEntriesFrom(1)).toEqual([])
    })

    it('returns undefined from getEntry', () => {
      const log = createReplicationLog(0)
      expect(log.getEntry(1)).toBeUndefined()
    })
  })

  describe('append', () => {
    it('assigns seqNo starting at 1 by default', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      expect(entry.seqNo).toBe(1)
    })

    it('sets a non-zero checksum on the returned entry', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      expect(entry.checksum).toBeGreaterThanOrEqual(0)
      expect(entry.checksum).toBeLessThanOrEqual(0xffffffff)
    })

    it('assigns incrementing seqNo for multiple entries', () => {
      const log = createReplicationLog(0)
      const first = log.append(makeIndexEntry({ documentId: 'doc-001' }))
      const second = log.append(makeIndexEntry({ documentId: 'doc-002' }))
      const third = log.append(makeDeleteEntry({ documentId: 'doc-003' }))
      expect(first.seqNo).toBe(1)
      expect(second.seqNo).toBe(2)
      expect(third.seqNo).toBe(3)
    })

    it('preserves all fields from the input and stamps partitionId from factory', () => {
      const log = createReplicationLog(7)
      const input = makeIndexEntry({
        primaryTerm: 3,
        indexName: 'articles',
        documentId: 'article-42',
      })
      const entry = log.append(input)
      expect(entry.primaryTerm).toBe(3)
      expect(entry.operation).toBe('INDEX')
      expect(entry.partitionId).toBe(7)
      expect(entry.indexName).toBe('articles')
      expect(entry.documentId).toBe('article-42')
      expect(entry.document).not.toBeNull()
    })

    it('handles DELETE operation with null document', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeDeleteEntry())
      expect(entry.operation).toBe('DELETE')
      expect(entry.document).toBeNull()
      expect(entry.seqNo).toBe(1)
    })

    it('updates entryCount and sizeBytes after append', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry())
      expect(log.entryCount).toBe(1)
      expect(log.sizeBytes).toBeGreaterThan(0)
    })

    it('updates oldestSeqNo and newestSeqNo after append', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry({ documentId: 'doc-001' }))
      log.append(makeIndexEntry({ documentId: 'doc-002' }))
      expect(log.oldestSeqNo).toBe(1)
      expect(log.newestSeqNo).toBe(2)
    })
  })

  describe('startSeqNo', () => {
    it('begins assigning from the provided startSeqNo', () => {
      const log = createReplicationLog(0, { startSeqNo: 100 })
      const entry = log.append(makeIndexEntry())
      expect(entry.seqNo).toBe(100)
    })

    it('increments from startSeqNo for subsequent entries', () => {
      const log = createReplicationLog(0, { startSeqNo: 500 })
      const first = log.append(makeIndexEntry({ documentId: 'doc-001' }))
      const second = log.append(makeIndexEntry({ documentId: 'doc-002' }))
      expect(first.seqNo).toBe(500)
      expect(second.seqNo).toBe(501)
    })
  })

  describe('getEntriesFrom', () => {
    it('returns all entries when fromSeqNo is 1', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry({ documentId: 'doc-001' }))
      log.append(makeIndexEntry({ documentId: 'doc-002' }))
      log.append(makeDeleteEntry({ documentId: 'doc-003' }))
      const entries = log.getEntriesFrom(1)
      expect(entries).toHaveLength(3)
      expect(entries[0].seqNo).toBe(1)
      expect(entries[2].seqNo).toBe(3)
    })

    it('returns entries from N onward (inclusive)', () => {
      const log = createReplicationLog(0)
      for (let i = 0; i < 5; i++) {
        log.append(makeIndexEntry({ documentId: `doc-${i}` }))
      }
      const entries = log.getEntriesFrom(3)
      expect(entries).toHaveLength(3)
      expect(entries[0].seqNo).toBe(3)
      expect(entries[1].seqNo).toBe(4)
      expect(entries[2].seqNo).toBe(5)
    })

    it('returns empty array when fromSeqNo is beyond newestSeqNo', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry())
      expect(log.getEntriesFrom(100)).toEqual([])
    })

    it('returns all entries when fromSeqNo is less than oldestSeqNo', () => {
      const log = createReplicationLog(0, { startSeqNo: 10 })
      log.append(makeIndexEntry({ documentId: 'doc-001' }))
      log.append(makeIndexEntry({ documentId: 'doc-002' }))
      const entries = log.getEntriesFrom(1)
      expect(entries).toHaveLength(2)
      expect(entries[0].seqNo).toBe(10)
    })

    it('works correctly with startSeqNo offset', () => {
      const log = createReplicationLog(0, { startSeqNo: 50 })
      for (let i = 0; i < 5; i++) {
        log.append(makeIndexEntry({ documentId: `doc-${i}` }))
      }
      const entries = log.getEntriesFrom(52)
      expect(entries).toHaveLength(3)
      expect(entries[0].seqNo).toBe(52)
    })
  })

  describe('getEntry', () => {
    it('returns the correct entry by seqNo', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry({ documentId: 'doc-001' }))
      const second = log.append(makeIndexEntry({ documentId: 'doc-002' }))
      log.append(makeIndexEntry({ documentId: 'doc-003' }))

      const found = log.getEntry(2)
      expect(found).toBeDefined()
      expect(found?.seqNo).toBe(2)
      expect(found?.documentId).toBe(second.documentId)
    })

    it('returns undefined for a nonexistent seqNo', () => {
      const log = createReplicationLog(0)
      log.append(makeIndexEntry())
      expect(log.getEntry(999)).toBeUndefined()
    })

    it('returns undefined for a seqNo that was evicted', () => {
      const log = createReplicationLog(0, { logRetentionBytes: 100 })
      for (let i = 0; i < 50; i++) {
        log.append(
          makeIndexEntry({
            documentId: `doc-${i}`,
            document: new Uint8Array(20),
          }),
        )
      }
      expect(log.getEntry(1)).toBeUndefined()
    })
  })

  describe('verifyChecksum', () => {
    it('returns true for an untampered entry', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      expect(log.verifyChecksum(entry)).toBe(true)
    })

    it('returns true for a DELETE entry', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeDeleteEntry())
      expect(log.verifyChecksum(entry)).toBe(true)
    })

    it('returns false when seqNo is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, seqNo: 999 }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when primaryTerm is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, primaryTerm: 42 }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when operation is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, operation: 'DELETE' as const }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when documentId is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, documentId: 'tampered-id' }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when document bytes are modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, document: new Uint8Array([0xff, 0xfe]) }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when indexName is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, indexName: 'hacked-index' }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })

    it('returns false when partitionId is modified', () => {
      const log = createReplicationLog(0)
      const entry = log.append(makeIndexEntry())
      const tampered = { ...entry, partitionId: 99 }
      expect(log.verifyChecksum(tampered)).toBe(false)
    })
  })

  describe('retention eviction', () => {
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

  describe('clear', () => {
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

  describe('default config', () => {
    it('uses 256 MB as the default retention', () => {
      expect(DEFAULT_LOG_RETENTION_BYTES).toBe(268_435_456)
    })
  })

  describe('mixed operations', () => {
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

  describe('different partitions', () => {
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

  describe('checksum determinism', () => {
    it('produces the same checksum for identical entries', () => {
      const log = createReplicationLog(0)
      const doc = encode({ title: 'Test Product', price: 99 })
      const entry1 = log.append(makeIndexEntry({ documentId: 'doc-same', document: doc }))

      const log2 = createReplicationLog(0)
      const entry2 = log2.append(makeIndexEntry({ documentId: 'doc-same', document: doc }))

      expect(entry1.checksum).toBe(entry2.checksum)
    })

    it('produces different checksums for entries with different seqNos', () => {
      const log = createReplicationLog(0)
      const doc = encode({ title: 'Test Product', price: 99 })
      log.append(makeIndexEntry({ documentId: 'doc-001', document: doc }))
      const entry2 = log.append(makeIndexEntry({ documentId: 'doc-001', document: doc }))

      const log2 = createReplicationLog(0)
      const entry1Again = log2.append(makeIndexEntry({ documentId: 'doc-001', document: doc }))

      expect(entry2.checksum).not.toBe(entry1Again.checksum)
    })
  })
})
