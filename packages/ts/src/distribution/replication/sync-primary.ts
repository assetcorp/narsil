import { ErrorCodes, NarsilError } from '../../errors'
import { decode } from '../../serialization/msgpack'
import type { SyncRequestPayload } from '../transport/types'
import type { ReplicationLog } from './types'

export function decideSyncTier(
  log: ReplicationLog,
  replicaLastSeqNo: number,
  replicaLastPrimaryTerm: number,
): 'incremental' | 'snapshot' {
  if (replicaLastSeqNo === 0) {
    return log.localLogEnd === 0 || log.oldestSeqNo === 1 ? 'incremental' : 'snapshot'
  }
  const primaryTerm = log.termAt(replicaLastSeqNo)
  return primaryTerm !== undefined && primaryTerm === replicaLastPrimaryTerm ? 'incremental' : 'snapshot'
}

function invalidSyncRequest(reason: string): NarsilError {
  return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID, `Invalid SyncRequestPayload: ${reason}`)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidSyncRequest(`"${field}" must be a non-empty string or absent`)
  }
  return value
}

export function decodeSyncRequest(payload: Uint8Array): SyncRequestPayload {
  let decoded: unknown
  try {
    decoded = decode(payload)
  } catch (error) {
    throw invalidSyncRequest(`the payload is not valid MessagePack (${error instanceof Error ? error.message : error})`)
  }
  return validateSyncRequest(decoded)
}

export function validateSyncRequest(decoded: unknown): SyncRequestPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw invalidSyncRequest('expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string') {
    throw invalidSyncRequest('"indexName" must be a string')
  }
  if (!isNonNegativeInteger(record.partitionId)) {
    throw invalidSyncRequest('"partitionId" must be a non-negative integer')
  }
  if (!isNonNegativeInteger(record.lastSeqNo)) {
    throw invalidSyncRequest('"lastSeqNo" must be a non-negative integer')
  }
  if (!isNonNegativeInteger(record.lastPrimaryTerm)) {
    throw invalidSyncRequest('"lastPrimaryTerm" must be a non-negative integer')
  }
  const indexUuid = optionalNonEmptyString(record.indexUuid, 'indexUuid')
  const syncSession = optionalNonEmptyString(record.syncSession, 'syncSession')
  return {
    indexName: record.indexName,
    partitionId: record.partitionId,
    lastSeqNo: record.lastSeqNo,
    lastPrimaryTerm: record.lastPrimaryTerm,
    ...(indexUuid === undefined ? {} : { indexUuid }),
    ...(syncSession === undefined ? {} : { syncSession }),
  }
}
