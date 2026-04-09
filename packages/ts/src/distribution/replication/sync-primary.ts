import { encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type { PartitionManager } from '../../partitioning/manager'
import { crc32 } from '../../serialization/crc32'
import type {
  ReplicationSnapshotHeader,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
  SyncEntriesPayload,
  SyncRequestPayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import type { ReplicationLog } from './types'

const SNAPSHOT_CHUNK_SIZE = 65_536

export interface SyncPrimaryDeps {
  log: ReplicationLog
  manager: PartitionManager
  sourceNodeId: string
  partitionId: number
  indexName: string
  primaryTerm: number
}

export function decideSyncTier(log: ReplicationLog, replicaLastSeqNo: number): 'incremental' | 'snapshot' {
  const oldest = log.oldestSeqNo
  if (oldest === undefined) {
    return replicaLastSeqNo === 0 ? 'incremental' : 'snapshot'
  }
  if (oldest <= replicaLastSeqNo + 1) {
    return 'incremental'
  }
  return 'snapshot'
}

export function handleSyncRequest(request: SyncRequestPayload, deps: SyncPrimaryDeps): TransportMessage {
  const tier = decideSyncTier(deps.log, request.lastSeqNo)

  if (tier === 'incremental') {
    return buildIncrementalResponse(request, deps)
  }

  return buildSnapshotStartResponse(deps)
}

function buildIncrementalResponse(request: SyncRequestPayload, deps: SyncPrimaryDeps): TransportMessage {
  const entries = deps.log.getEntriesFrom(request.lastSeqNo + 1)

  const payload: SyncEntriesPayload = {
    entries,
    isLast: true,
  }

  return {
    type: ReplicationMessageTypes.SYNC_ENTRIES,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

function buildSnapshotStartResponse(deps: SyncPrimaryDeps): TransportMessage {
  const snapshotBytes = deps.manager.serializePartitionToBytes(deps.partitionId)
  const checksum = crc32(snapshotBytes)
  const newestSeqNo = deps.log.newestSeqNo ?? 0

  const header: ReplicationSnapshotHeader = {
    lastSeqNo: newestSeqNo,
    primaryTerm: deps.primaryTerm,
    partitionId: deps.partitionId,
    indexName: deps.indexName,
    checksum,
  }

  const startPayload: SnapshotStartPayload = {
    header,
    totalBytes: snapshotBytes.byteLength,
  }

  return {
    type: ReplicationMessageTypes.SNAPSHOT_START,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(startPayload),
  }
}

export function handleSnapshotStream(deps: SyncPrimaryDeps, respond: (response: TransportMessage) => void): void {
  const snapshotBytes = deps.manager.serializePartitionToBytes(deps.partitionId)
  const checksum = crc32(snapshotBytes)
  const snapshotSeqNo = deps.log.newestSeqNo ?? 0

  let offset = 0
  while (offset < snapshotBytes.byteLength) {
    const end = Math.min(offset + SNAPSHOT_CHUNK_SIZE, snapshotBytes.byteLength)
    const chunk = snapshotBytes.subarray(offset, end)

    const chunkPayload: SnapshotChunkPayload = {
      partitionId: deps.partitionId,
      indexName: deps.indexName,
      offset,
      data: chunk,
    }

    respond({
      type: ReplicationMessageTypes.SNAPSHOT_CHUNK,
      sourceId: deps.sourceNodeId,
      requestId: generateId(),
      payload: encode(chunkPayload),
    })

    offset = end
  }

  const endPayload: SnapshotEndPayload = {
    partitionId: deps.partitionId,
    indexName: deps.indexName,
    totalBytes: snapshotBytes.byteLength,
    checksum,
  }

  respond({
    type: ReplicationMessageTypes.SNAPSHOT_END,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(endPayload),
  })

  const trailingEntries = deps.log.getEntriesFrom(snapshotSeqNo + 1)
  if (trailingEntries.length > 0) {
    const trailingPayload: SyncEntriesPayload = {
      entries: trailingEntries,
      isLast: true,
    }

    respond({
      type: ReplicationMessageTypes.SYNC_ENTRIES,
      sourceId: deps.sourceNodeId,
      requestId: generateId(),
      payload: encode(trailingPayload),
    })
  }
}

export function validateSyncRequest(decoded: unknown): SyncRequestPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid SyncRequestPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string') {
    throw new Error('Invalid SyncRequestPayload: "indexName" must be a string')
  }
  if (typeof record.partitionId !== 'number') {
    throw new Error('Invalid SyncRequestPayload: "partitionId" must be a number')
  }
  if (typeof record.lastSeqNo !== 'number') {
    throw new Error('Invalid SyncRequestPayload: "lastSeqNo" must be a number')
  }
  if (typeof record.lastPrimaryTerm !== 'number') {
    throw new Error('Invalid SyncRequestPayload: "lastPrimaryTerm" must be a number')
  }
  return record as unknown as SyncRequestPayload
}
