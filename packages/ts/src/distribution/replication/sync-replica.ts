import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { type ErrorCode, ErrorCodes, NarsilError, type NarsilErrorCode } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { crc32 } from '../../serialization/crc32'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { VectorIndex } from '../../vector/vector-index'
import type {
  NodeTransport,
  SnapshotStartPayload,
  SyncEntriesPayload,
  SyncRequestPayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import { MAX_SNAPSHOT_SIZE_BYTES } from './constants'
import { applyDeleteEntry, applyIndexEntry, validateReplicationEntry } from './replica'
import {
  createSnapshotStreamState,
  finalizeSnapshotStream,
  handleIncomingSnapshotRecord,
  seedSnapshotStreamStart,
} from './snapshot-stream-assembler'
import type { ReplicationLog, ReplicationLogEntry } from './types'

export interface SyncReplicaDeps {
  manager: PartitionManager
  log: ReplicationLog
  transport: NodeTransport
  sourceNodeId: string
  partitionId: number
  indexName: string
  vectorFieldPaths: Set<string>
  vecIndexes: Map<string, VectorIndex>
}

export interface SyncResult {
  synced: boolean
  newSeqNo: number
  tier: 'incremental' | 'snapshot' | 'none'
  entriesApplied: number
  error?: NarsilError
}

export async function initiateSync(
  primaryNodeId: string,
  lastSeqNo: number,
  lastPrimaryTerm: number,
  deps: SyncReplicaDeps,
): Promise<SyncResult> {
  const requestPayload: SyncRequestPayload = {
    indexName: deps.indexName,
    partitionId: deps.partitionId,
    lastSeqNo,
    lastPrimaryTerm,
  }

  const requestMessage: TransportMessage = {
    type: ReplicationMessageTypes.SYNC_REQUEST,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(requestPayload),
  }

  const response = await deps.transport.send(primaryNodeId, requestMessage)

  if (response.type === ReplicationMessageTypes.SYNC_ENTRIES) {
    return handleIncrementalSync(response, lastSeqNo, lastPrimaryTerm, deps)
  }

  if (response.type === ReplicationMessageTypes.SNAPSHOT_START) {
    return handleSnapshotSync(response, primaryNodeId, lastPrimaryTerm, deps)
  }

  return {
    synced: false,
    newSeqNo: lastSeqNo,
    tier: 'none',
    entriesApplied: 0,
    error: new NarsilError(
      ErrorCodes.REPLICATION_SYNC_FAILED,
      `Sync request received unexpected response type '${response.type}' from primary '${primaryNodeId}'`,
      { indexName: deps.indexName, partitionId: deps.partitionId, responseType: response.type },
    ),
  }
}

function handleIncrementalSync(
  response: TransportMessage,
  lastSeqNo: number,
  localPrimaryTerm: number,
  deps: SyncReplicaDeps,
): SyncResult {
  const payload = decode(response.payload) as SyncEntriesPayload
  const entries = payload.entries

  if (entries.length === 0) {
    return { synced: true, newSeqNo: lastSeqNo, tier: 'incremental', entriesApplied: 0 }
  }

  let highestSeqNo = lastSeqNo
  let applied = 0

  for (const entry of entries) {
    const validation = validateReplicationEntry(entry, localPrimaryTerm, deps.log)
    if (!validation.valid) {
      return {
        synced: false,
        newSeqNo: highestSeqNo,
        tier: 'incremental',
        entriesApplied: applied,
        error: entryValidationError(entry.seqNo, validation.error, deps),
      }
    }

    applyEntry(entry, deps)
    appendToReplicaLog(entry, deps.log)

    if (entry.seqNo > highestSeqNo) {
      highestSeqNo = entry.seqNo
    }
    applied += 1
  }

  return { synced: true, newSeqNo: highestSeqNo, tier: 'incremental', entriesApplied: applied }
}

async function handleSnapshotSync(
  startResponse: TransportMessage,
  primaryNodeId: string,
  localPrimaryTerm: number,
  deps: SyncReplicaDeps,
): Promise<SyncResult> {
  const startPayload = decode(startResponse.payload) as SnapshotStartPayload
  const header = startPayload.header
  const expectedTotalBytes = startPayload.totalBytes

  if (expectedTotalBytes > MAX_SNAPSHOT_SIZE_BYTES) {
    return {
      synced: false,
      newSeqNo: header.lastSeqNo,
      tier: 'snapshot',
      entriesApplied: 0,
      error: new NarsilError(
        ErrorCodes.REPLICATION_SYNC_FAILED,
        `Snapshot of ${expectedTotalBytes} bytes exceeds the ${MAX_SNAPSHOT_SIZE_BYTES} byte limit`,
        { indexName: deps.indexName, partitionId: deps.partitionId, totalBytes: expectedTotalBytes },
      ),
    }
  }

  const fetchMessage: TransportMessage = {
    type: ReplicationMessageTypes.SNAPSHOT_CHUNK,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode({
      partitionId: deps.partitionId,
      indexName: deps.indexName,
    }),
  }

  const streamState = createSnapshotStreamState({ indexName: deps.indexName, partitionId: deps.partitionId })
  seedSnapshotStreamStart(streamState, startPayload)
  if (streamState.failure !== null) {
    return {
      synced: false,
      newSeqNo: header.lastSeqNo,
      tier: 'snapshot',
      entriesApplied: 0,
      error: snapshotStreamError(streamState.failure.message, streamState.failure.code, deps),
    }
  }
  const trailingEntries: ReplicationLogEntry[] = []

  await deps.transport.stream(primaryNodeId, fetchMessage, (chunk: Uint8Array) => {
    if (streamState.failure !== null) {
      return
    }
    let record: Record<string, unknown>
    try {
      const decoded = decode(chunk)
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
        return
      }
      record = decoded as Record<string, unknown>
    } catch (_) {
      return
    }
    if (Array.isArray(record.entries) && typeof record.isLast === 'boolean') {
      const entriesPayload = record as unknown as SyncEntriesPayload
      for (const entry of entriesPayload.entries) {
        trailingEntries.push(entry)
      }
      return
    }
    handleIncomingSnapshotRecord(streamState, record)
  })

  const finalized = finalizeSnapshotStream(streamState)
  if (!finalized.ok) {
    return {
      synced: false,
      newSeqNo: header.lastSeqNo,
      tier: 'snapshot',
      entriesApplied: 0,
      error: snapshotStreamError(finalized.message, finalized.code, deps),
    }
  }

  const computedChecksum = crc32(finalized.bytes)
  if (computedChecksum !== header.checksum) {
    return {
      synced: false,
      newSeqNo: header.lastSeqNo,
      tier: 'snapshot',
      entriesApplied: 0,
      error: new NarsilError(
        ErrorCodes.REPLICATION_SNAPSHOT_CORRUPT,
        `Snapshot checksum ${computedChecksum} does not match header checksum ${header.checksum}`,
        {
          indexName: deps.indexName,
          partitionId: deps.partitionId,
          computedChecksum,
          headerChecksum: header.checksum,
        },
      ),
    }
  }

  const partition = deserializePayloadV2(finalized.bytes)
  deps.manager.deserializePartition(deps.partitionId, partition)

  let highestSeqNo = header.lastSeqNo
  let applied = 0

  for (const entry of trailingEntries) {
    const validation = validateReplicationEntry(entry, localPrimaryTerm, deps.log)
    if (!validation.valid) {
      return {
        synced: false,
        newSeqNo: highestSeqNo,
        tier: 'snapshot',
        entriesApplied: applied,
        error: entryValidationError(entry.seqNo, validation.error, deps),
      }
    }

    applyEntry(entry, deps)
    appendToReplicaLog(entry, deps.log)

    if (entry.seqNo > highestSeqNo) {
      highestSeqNo = entry.seqNo
    }
    applied += 1
  }

  return { synced: true, newSeqNo: highestSeqNo, tier: 'snapshot', entriesApplied: applied }
}

function entryValidationError(seqNo: number, code: ErrorCode | undefined, deps: SyncReplicaDeps): NarsilError {
  return new NarsilError(code ?? ErrorCodes.REPLICATION_SYNC_FAILED, `Invalid replication entry ${seqNo}`, {
    indexName: deps.indexName,
    partitionId: deps.partitionId,
    seqNo,
  })
}

function snapshotStreamError(message: string, cause: NarsilErrorCode, deps: SyncReplicaDeps): NarsilError {
  return new NarsilError(ErrorCodes.REPLICATION_SYNC_FAILED, `Snapshot sync failed: ${message}`, {
    indexName: deps.indexName,
    partitionId: deps.partitionId,
    cause,
  })
}

function applyEntry(entry: ReplicationLogEntry, deps: SyncReplicaDeps): void {
  if (entry.operation === 'INDEX') {
    applyIndexEntry(entry, deps.manager, deps.vectorFieldPaths, deps.vecIndexes)
  } else {
    applyDeleteEntry(entry, deps.manager, deps.vecIndexes)
  }
}

function appendToReplicaLog(entry: ReplicationLogEntry, log: ReplicationLog): void {
  log.append({
    primaryTerm: entry.primaryTerm,
    operation: entry.operation,
    partitionId: entry.partitionId,
    indexName: entry.indexName,
    documentId: entry.documentId,
    document: entry.document,
  })
}
