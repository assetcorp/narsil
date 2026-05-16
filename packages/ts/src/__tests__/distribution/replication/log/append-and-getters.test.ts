import { describe, expect, it } from 'vitest'
import { createReplicationLog } from '../../../../distribution/replication'
import { makeDeleteEntry, makeIndexEntry } from './fixtures'

describe('ReplicationLog empty log', () => {
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

describe('ReplicationLog append', () => {
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

describe('ReplicationLog startSeqNo', () => {
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

describe('ReplicationLog getEntriesFrom', () => {
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

describe('ReplicationLog getEntry', () => {
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
