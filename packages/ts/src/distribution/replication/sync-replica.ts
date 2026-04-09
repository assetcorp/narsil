import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type { PartitionManager } from '../../partitioning/manager'
import { crc32 } from '../../serialization/crc32'
import { deserializePayloadV2 } from '../../serialization/payload-v2'
import type { VectorIndex } from '../../vector/vector-index'
import type {
  NodeTransport,
  SnapshotChunkPayload,
  SnapshotEndPayload,
  SnapshotStartPayload,
  SyncEntriesPayload,
  SyncRequestPayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import { applyDeleteEntry, applyIndexEntry, validateReplicationEntry } from './replica'
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

  return { synced: false, newSeqNo: lastSeqNo, tier: 'none', entriesApplied: 0 }
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
      return { synced: false, newSeqNo: highestSeqNo, tier: 'incremental', entriesApplied: applied }
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

  const fetchMessage: TransportMessage = {
    type: ReplicationMessageTypes.SNAPSHOT_CHUNK,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode({
      partitionId: deps.partitionId,
      indexName: deps.indexName,
    }),
  }

  const receivedChunks: Uint8Array[] = []
  let receivedEnd: SnapshotEndPayload | undefined
  let trailingEntries: ReplicationLogEntry[] = []

  await deps.transport.stream(primaryNodeId, fetchMessage, (chunk: Uint8Array) => {
    const decoded = decode(chunk) as Record<string, unknown>

    if (isSnapshotChunkPayload(decoded)) {
      receivedChunks.push((decoded as unknown as SnapshotChunkPayload).data)
    } else if (isSnapshotEndPayload(decoded)) {
      receivedEnd = decoded as unknown as SnapshotEndPayload
    } else if (isSyncEntriesPayload(decoded)) {
      const entriesPayload = decoded as unknown as SyncEntriesPayload
      trailingEntries = trailingEntries.concat(entriesPayload.entries)
    }
  })

  if (receivedEnd === undefined) {
    return { synced: false, newSeqNo: header.lastSeqNo, tier: 'snapshot', entriesApplied: 0 }
  }

  const snapshotBytes = assembleChunks(receivedChunks, expectedTotalBytes)
  if (snapshotBytes === null) {
    return { synced: false, newSeqNo: header.lastSeqNo, tier: 'snapshot', entriesApplied: 0 }
  }

  const computedChecksum = crc32(snapshotBytes)
  if (computedChecksum !== header.checksum) {
    return { synced: false, newSeqNo: header.lastSeqNo, tier: 'snapshot', entriesApplied: 0 }
  }

  if (receivedEnd.totalBytes !== expectedTotalBytes) {
    return { synced: false, newSeqNo: header.lastSeqNo, tier: 'snapshot', entriesApplied: 0 }
  }

  if (receivedEnd.checksum !== header.checksum) {
    return { synced: false, newSeqNo: header.lastSeqNo, tier: 'snapshot', entriesApplied: 0 }
  }

  const partition = deserializePayloadV2(snapshotBytes)
  deps.manager.deserializePartition(deps.partitionId, partition)

  let highestSeqNo = header.lastSeqNo
  let applied = 0

  for (const entry of trailingEntries) {
    const validation = validateReplicationEntry(entry, localPrimaryTerm, deps.log)
    if (!validation.valid) {
      break
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

function assembleChunks(chunks: Uint8Array[], expectedTotalBytes: number): Uint8Array | null {
  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.byteLength
  }

  if (totalLength !== expectedTotalBytes) {
    return null
  }

  const assembled = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    assembled.set(chunk, offset)
    offset += chunk.byteLength
  }

  return assembled
}

function isSnapshotChunkPayload(obj: Record<string, unknown>): boolean {
  return typeof obj.offset === 'number' && obj.data instanceof Uint8Array && typeof obj.partitionId === 'number'
}

function isSnapshotEndPayload(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.totalBytes === 'number' &&
    typeof obj.checksum === 'number' &&
    typeof obj.partitionId === 'number' &&
    obj.data === undefined &&
    obj.offset === undefined
  )
}

function isSyncEntriesPayload(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.entries) && typeof obj.isLast === 'boolean'
}
