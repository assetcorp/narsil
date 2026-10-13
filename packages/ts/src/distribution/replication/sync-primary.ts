import type { SyncRequestPayload } from '../transport/types'
import type { ReplicationLog } from './types'

export function decideSyncTier(log: ReplicationLog, replicaLastSeqNo: number): 'incremental' | 'snapshot' {
  const oldest = log.oldestSeqNo
  if (oldest === undefined) {
    if (log.localLogEnd === 0) {
      return replicaLastSeqNo === 0 ? 'incremental' : 'snapshot'
    }
    return replicaLastSeqNo >= log.localLogEnd ? 'incremental' : 'snapshot'
  }
  if (oldest <= replicaLastSeqNo + 1) {
    return 'incremental'
  }
  return 'snapshot'
}

export function validateSyncRequest(decoded: unknown): SyncRequestPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid SyncRequestPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string') {
    throw new Error('Invalid SyncRequestPayload: "indexName" must be a string')
  }
  if (typeof record.partitionId !== 'number' || !Number.isInteger(record.partitionId) || record.partitionId < 0) {
    throw new Error('Invalid SyncRequestPayload: "partitionId" must be a non-negative integer')
  }
  if (typeof record.lastSeqNo !== 'number' || !Number.isInteger(record.lastSeqNo) || record.lastSeqNo < 0) {
    throw new Error('Invalid SyncRequestPayload: "lastSeqNo" must be a non-negative integer')
  }
  if (
    typeof record.lastPrimaryTerm !== 'number' ||
    !Number.isInteger(record.lastPrimaryTerm) ||
    record.lastPrimaryTerm < 0
  ) {
    throw new Error('Invalid SyncRequestPayload: "lastPrimaryTerm" must be a non-negative integer')
  }
  return record as unknown as SyncRequestPayload
}
