import { buildEntry } from '../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { MutationRecord } from './types'

export function buildMutationEntry(record: MutationRecord, seqNo: number): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: SINGLE_NODE_PRIMARY_TERM,
    operation: record.operation,
    partitionId: record.partitionId,
    indexName: record.indexName,
    documentId: record.documentId,
    document: record.document,
  })
}
