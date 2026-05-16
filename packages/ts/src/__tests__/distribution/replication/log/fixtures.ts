import { encode } from '@msgpack/msgpack'
import type { ReplicationLogEntry } from '../../../../distribution/replication'

export function makeIndexEntry(
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

export function makeDeleteEntry(
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
