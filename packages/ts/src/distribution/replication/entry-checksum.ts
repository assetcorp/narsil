import { crc32, encode } from '#platform/storage-host'
import type { ReplicationLogEntry } from './types'

export function computeEntryChecksum(entry: Omit<ReplicationLogEntry, 'checksum'>): number {
  const payload = encode([
    entry.seqNo,
    entry.primaryTerm,
    entry.operation,
    entry.partitionId,
    entry.indexName,
    entry.documentId,
    entry.document,
  ])
  return crc32(payload)
}

export function buildEntry(fields: Omit<ReplicationLogEntry, 'checksum'>): ReplicationLogEntry {
  return { ...fields, checksum: computeEntryChecksum(fields) }
}
