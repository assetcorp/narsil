import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createReplicationLog } from '../../../../distribution/replication'
import { makeDeleteEntry, makeIndexEntry } from './fixtures'

describe('ReplicationLog verifyChecksum', () => {
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

describe('ReplicationLog checksum determinism', () => {
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
