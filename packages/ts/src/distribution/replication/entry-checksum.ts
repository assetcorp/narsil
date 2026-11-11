import { crc32, encode } from '#platform/storage-host'
import { REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES } from './constants'
import type { ReplicationLogEntry } from './types'

type EntryContent = Omit<ReplicationLogEntry, 'checksum'>

function checksumFields(entry: EntryContent): unknown[] {
  const fields: unknown[] = [
    entry.seqNo,
    entry.primaryTerm,
    entry.operation,
    entry.partitionId,
    entry.indexName,
    entry.documentId,
    entry.document,
  ]
  if (entry.previousDocument !== undefined) fields.push(entry.previousDocument)
  return fields
}

export function computeEntryChecksum(entry: EntryContent): number {
  return crc32(encode(checksumFields(entry)))
}

export function buildEntry(fields: EntryContent): ReplicationLogEntry {
  if (fields.previousDocument === undefined) {
    return {
      seqNo: fields.seqNo,
      primaryTerm: fields.primaryTerm,
      operation: fields.operation,
      partitionId: fields.partitionId,
      indexName: fields.indexName,
      documentId: fields.documentId,
      document: fields.document,
      checksum: computeEntryChecksum(fields),
    }
  }
  return {
    seqNo: fields.seqNo,
    primaryTerm: fields.primaryTerm,
    operation: fields.operation,
    partitionId: fields.partitionId,
    indexName: fields.indexName,
    documentId: fields.documentId,
    document: fields.document,
    previousDocument: fields.previousDocument,
    checksum: computeEntryChecksum(fields),
  }
}

export function entryByteEstimate(
  entry: Pick<ReplicationLogEntry, 'indexName' | 'documentId' | 'document' | 'previousDocument'>,
): number {
  return (
    REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES +
    entry.indexName.length +
    entry.documentId.length +
    (entry.document?.byteLength ?? 0) +
    (entry.previousDocument?.byteLength ?? 0)
  )
}
