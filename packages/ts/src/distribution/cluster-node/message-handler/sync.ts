import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { decode } from '../../../serialization/msgpack'
import type { PartitionAssignment } from '../../coordinator/types'
import { defaultSpoolDirectory, spoolSnapshotStream } from '../../replication/snapshot-spool'
import { decideSyncTier, validateSyncRequest } from '../../replication/sync-primary'
import type { RespondFn, SyncEntriesPayload, SyncRequestPayload, TransportMessage } from '../../transport/types'
import { ReplicationMessageTypes } from '../../transport/types'
import { isCurrentSyncSession, openSyncSession } from '../catch-up/sessions'
import { recordReplicaPosition, recordSnapshotSyncRequest } from '../catch-up/state'
import { holdsAnotherIndex } from '../request-identity'
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
  if (holdsAnotherIndex(deps.engine.indexUuidOf(request.indexName), request.indexUuid)) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND,
      `Node '${deps.nodeId}' holds a copy of an earlier index named '${request.indexName}', so it cannot serve a sync for partition ${request.partitionId}`,
      { indexName: request.indexName, partitionId: request.partitionId, primaryNodeId: deps.nodeId },
    )
  }
  const release = await deps.engine.acquireIndexForReplication(request.indexName)
  const fromReplica = message.sourceId !== deps.nodeId
  try {
    const log = deps.writeDeps.getReplicationLog(request.indexName, request.partitionId)
    const tier = decideSyncTier(log, request.lastSeqNo, request.lastPrimaryTerm)
    const syncSession = currentSyncSessionOf(request, message.sourceId, assignment, deps)
    if (tier === 'incremental') {
      if (fromReplica) {
        recordReplicaPosition(
          deps.writeDeps.catchUp,
          request.indexName,
          request.partitionId,
          message.sourceId,
          request.lastSeqNo,
          log.localLogEnd,
          request.syncSession !== undefined,
        )
      }
      await sendSyncEntriesResponse(message, respond, deps, log.getEntriesFrom(request.lastSeqNo + 1), syncSession)
      return
    }
    if (fromReplica) {
      recordSnapshotSyncRequest(deps.writeDeps.catchUp, request.indexName, request.partitionId, message.sourceId)
    }

    const snapshotSeqNo = log.localLogEnd
    let snapshotPrimaryTerm = log.termAt(snapshotSeqNo) ?? 0
    const sink = createSingleResponseSink(respond)
    await streamValidatedSnapshotRequest(
      message,
      sink,
      request.indexName,
      {
        nodeId: deps.nodeId,
        engine: deps.engine,
        coordinator: deps.coordinator,
        state: deps.snapshotSyncState,
      },
      {
        metadata: {
          partitionId: request.partitionId,
          lastSeqNo: snapshotSeqNo,
          primaryTerm: snapshotPrimaryTerm,
        },
        syncSession,
        buildSnapshot: async () => {
          const archive = await deps.engine.archiveReplicationPartition(request.indexName, request.partitionId, () => {
            snapshotPrimaryTerm = log.termAt(log.localLogEnd) ?? 0
            return log.localLogEnd
          })
          const directory = deps.snapshotSpoolDirectory ?? defaultSpoolDirectory()
          return {
            ...(await spoolSnapshotStream(directory, archive.stream)),
            lastSeqNo: archive.lastSeqNo,
            primaryTerm: snapshotPrimaryTerm,
          }
        },
        afterSnapshot: async (trailingSink, build) => {
          const snapshotEnd = build.lastSeqNo ?? snapshotSeqNo
          await sendSyncEntriesResponse(message, trailingSink, deps, log.getEntriesFrom(snapshotEnd + 1), syncSession)
        },
      },
    )
  } finally {
    release()
  }
}

function currentSyncSessionOf(
  request: SyncRequestPayload,
  sourceNodeId: string,
  assignment: PartitionAssignment,
  deps: DataNodeHandlerDeps,
): string {
  const { indexName, partitionId, syncSession } = request
  const catchUp = deps.writeDeps.catchUp
  if (syncSession === undefined) {
    return openSyncSession(catchUp, indexName, partitionId, sourceNodeId, assignment.primaryTerm, assignment.replicas)
  }
  if (isCurrentSyncSession(catchUp, indexName, partitionId, sourceNodeId, syncSession, assignment.primaryTerm)) {
    return syncSession
  }
  throw new NarsilError(
    ErrorCodes.REPLICATION_SYNC_FAILED,
    `Node '${sourceNodeId}' reported a sync of partition ${partitionId} of index '${indexName}' that is no longer its current sync, so it must open a new one`,
    { indexName, partitionId, sourceNodeId },
  )
}

export async function sendSyncEntriesResponse(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
  entries: SyncEntriesPayload['entries'],
  syncSession: string,
): Promise<void> {
  const payload: SyncEntriesPayload = {
    entries,
    isLast: true,
    syncSession,
  }
  await respond({
    type: ReplicationMessageTypes.SYNC_ENTRIES,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(payload),
  })
}
