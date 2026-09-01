import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { crc32 } from '../../../serialization/crc32'
import { decideSyncTier, validateSyncRequest } from '../../replication/sync-primary'
import type { RespondFn, SyncEntriesPayload, TransportMessage } from '../../transport/types'
import { ReplicationMessageTypes } from '../../transport/types'
import { recordReplicaPosition } from '../catch-up/state'
import { authorizeSnapshotRequest } from '../snapshot-auth'
import { createSingleResponseSink } from '../snapshot-stream-writer'
import { streamValidatedSnapshotRequest } from '../snapshot-sync-handler'
import type { DataNodeHandlerDeps } from './types'

export async function handleSyncRequestMessage(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const request = validateSyncRequest(decode(message.payload))

  const authResult = await authorizeSnapshotRequest(deps.coordinator, request.indexName, message.sourceId)
  if (authResult.outcome === 'denied') {
    throw new NarsilError(authResult.code, authResult.reason, {
      indexName: request.indexName,
      partitionId: request.partitionId,
      sourceNodeId: message.sourceId,
    })
  }

  const table = await deps.coordinator.getAllocation(request.indexName)
  const assignment = table?.assignments.get(request.partitionId)
  if (assignment === undefined) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
      `No assignment exists for sync request partition ${request.partitionId} of index '${request.indexName}'`,
      { indexName: request.indexName, partitionId: request.partitionId },
    )
  }

  if (assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
      `Node '${deps.nodeId}' is not primary for sync request partition ${request.partitionId} of index '${request.indexName}'`,
      {
        indexName: request.indexName,
        partitionId: request.partitionId,
        localNodeId: deps.nodeId,
        primaryNodeId: assignment.primary,
      },
    )
  }

  const sourceAssigned = assignment.primary === message.sourceId || assignment.replicas.includes(message.sourceId)
  if (!sourceAssigned) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
      `Node '${message.sourceId}' is not assigned to partition ${request.partitionId} of index '${request.indexName}'`,
      { indexName: request.indexName, partitionId: request.partitionId, sourceNodeId: message.sourceId },
    )
  }

  if (request.lastPrimaryTerm > assignment.primaryTerm) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      `Replica term ${request.lastPrimaryTerm} is newer than primary term ${assignment.primaryTerm}`,
      {
        indexName: request.indexName,
        partitionId: request.partitionId,
        lastPrimaryTerm: request.lastPrimaryTerm,
        primaryTerm: assignment.primaryTerm,
      },
    )
  }

  const localIndex = deps.engine.listIndexes().find(index => index.name === request.indexName)
  if (localIndex === undefined) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND,
      `Node '${deps.nodeId}' holds no copy of index '${request.indexName}' yet, so it cannot serve a sync for partition ${request.partitionId}`,
      { indexName: request.indexName, partitionId: request.partitionId, primaryNodeId: deps.nodeId },
    )
  }
  if (localIndex.state !== 'open') {
    await deps.engine.open(request.indexName)
  }

  if (message.sourceId !== deps.nodeId) {
    recordReplicaPosition(
      deps.writeDeps.catchUp,
      request.indexName,
      request.partitionId,
      message.sourceId,
      request.lastSeqNo,
    )
  }

  const log = deps.writeDeps.getReplicationLog(request.indexName, request.partitionId)
  const tier = decideSyncTier(log, request.lastSeqNo)
  if (tier === 'incremental') {
    await sendSyncEntriesResponse(message, respond, deps, log.getEntriesFrom(request.lastSeqNo + 1))
    return
  }

  const snapshotSeqNo = log.localLogEnd
  const sink = createSingleResponseSink(respond)
  await streamValidatedSnapshotRequest(
    message,
    sink,
    { indexName: request.indexName, partitionId: request.partitionId },
    {
      nodeId: deps.nodeId,
      engine: deps.engine,
      coordinator: deps.coordinator,
      state: deps.snapshotSyncState,
      resolveHeaderMetadata: deps.resolveHeaderMetadata,
    },
    {
      metadata: {
        partitionId: request.partitionId,
        lastSeqNo: snapshotSeqNo,
        primaryTerm: assignment.primaryTerm,
      },
      closeOnEnd: false,
      disableBuildCache: true,
      buildSnapshot: async () => {
        const bytes = await deps.engine.serializeReplicationPartition(request.indexName, request.partitionId)
        return { bytes, checksum: crc32(bytes) }
      },
      afterSnapshot: async trailingSink => {
        const entries = log.getEntriesFrom(snapshotSeqNo + 1)
        await sendSyncEntriesResponse(message, trailingSink, deps, entries)
      },
    },
  )
}

export async function sendSyncEntriesResponse(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
  entries: SyncEntriesPayload['entries'],
): Promise<void> {
  const payload: SyncEntriesPayload = {
    entries,
    isLast: true,
  }
  await respond({
    type: ReplicationMessageTypes.SYNC_ENTRIES,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(payload),
  })
}
