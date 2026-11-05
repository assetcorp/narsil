import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { type RespondFn, SyncMessageTypes, type TransportMessage } from '../../transport/types'
import type { DataNodeHandlerDeps } from '../message-handler/types'
import { leadingAssignment } from '../reshard/leadership'
import { encodeSyncReadReply, type SyncReadReply, type SyncReadRequest, validateSyncReadRequest } from './read-message'

export type SyncReadDeps = Pick<DataNodeHandlerDeps, 'nodeId' | 'engine' | 'writeDeps'>

export async function answerSyncRead(deps: SyncReadDeps, request: SyncReadRequest): Promise<SyncReadReply> {
  const { indexName, indexUuid, partitionId, afterSeqNo, maxBytes } = request
  await leadingAssignment(deps.writeDeps, indexName, partitionId)
  if (deps.engine.indexUuidOf(indexName) !== indexUuid) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Node '${deps.nodeId}' holds no copy of index '${indexName}'`, {
      indexName,
      indexUuid,
    })
  }
  const storage = deps.engine.syncStorage()
  if (storage === null) {
    throw new NarsilError(
      ErrorCodes.SYNC_DURABILITY_REQUIRED,
      `Node '${deps.nodeId}' has no write-ahead log durability, so it can't read the log for a device feed`,
      { indexName },
    )
  }
  const replicationLog = deps.writeDeps.getReplicationLog(indexName, partitionId)
  const log = await storage.openPartitionLog(indexName, partitionId)
  const head = Math.min(replicationLog.commitPoint, log.head)
  const highestSeqNo = Math.max(log.head, replicationLog.localLogEnd)
  const read =
    afterSeqNo < head
      ? await storage.readPartitionLog(indexName, partitionId, afterSeqNo, head, maxBytes)
      : { frames: [], bytes: 0, gone: false }
  const bytesBehind = afterSeqNo < head ? await storage.logBytesAfter(log, afterSeqNo) : 0
  const oldestSeqNo = read.gone ? Math.max(log.oldestSeqNo, afterSeqNo + 2) : log.oldestSeqNo
  return { frames: read.frames, head, highestSeqNo, oldestSeqNo, bytesBehind }
}

export async function handleSyncRead(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const request = validateSyncReadRequest(decode(message.payload))
  if (request === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A sync.read request is malformed', {
      sourceNodeId: message.sourceId,
    })
  }
  const reply = await answerSyncRead(deps, request)
  await respond({
    type: SyncMessageTypes.READ,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encodeSyncReadReply(reply),
  })
}
