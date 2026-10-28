import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../../errors'
import { MAX_REPLICATION_FACTOR } from '../../../constants'
import type { ClusterCoordinator } from '../../../coordinator/types'
import { isRecord, isValidInteger } from '../../../payload-guards'
import type { ReplicationFactorPayload, RespondFn, TransportMessage } from '../../../transport/types'
import { ClusterMessageTypes } from '../../../transport/types'
import { putIndexReplicationFactor } from '../../index-metadata'
import { allocateIndexNow } from './allocation'
import type { EventLoopState } from './state'

function encodeRefusal(error: unknown): Uint8Array {
  const code = error instanceof NarsilError ? error.code : ErrorCodes.ALLOCATION_FAILED
  const text = error instanceof Error ? error.message : String(error)
  try {
    return encode({ error: true, code, message: text, details: error instanceof NarsilError ? error.details : {} })
  } catch (_) {
    return encode({ error: true, code, message: text })
  }
}

function readPayload(message: TransportMessage): ReplicationFactorPayload {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    decoded = null
  }
  if (!isRecord(decoded) || typeof decoded.indexName !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A replication factor request must name an index', {})
  }
  const { indexName, replicationFactor } = decoded
  if (!isValidInteger(replicationFactor) || replicationFactor < 0 || replicationFactor > MAX_REPLICATION_FACTOR) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The replication factor of index '${indexName}' must be an integer from 0 to ${MAX_REPLICATION_FACTOR}`,
      { indexName, replicationFactor: String(replicationFactor) },
    )
  }
  return { indexName, replicationFactor }
}

async function applyReplicationFactor(
  state: EventLoopState,
  message: TransportMessage,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): Promise<ReplicationFactorPayload> {
  if (!isActive()) {
    throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, `Node '${nodeId}' does not hold the controller lease`, {
      nodeId,
    })
  }
  const payload = readPayload(message)
  const metadata = await putIndexReplicationFactor(coordinator, payload.indexName, payload.replicationFactor)
  if (metadata === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${payload.indexName}' has no metadata in the cluster`, {
      indexName: payload.indexName,
    })
  }
  await allocateIndexNow(state, coordinator, payload.indexName, isActive, onError)
  return payload
}

export function handleReplicationFactorMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): void {
  applyReplicationFactor(state, message, coordinator, nodeId, isActive, onError).then(
    payload =>
      respond({
        type: ClusterMessageTypes.REPLICATION_FACTOR,
        sourceId: nodeId,
        requestId: message.requestId,
        payload: encode(payload),
      }).catch(() => {}),
    error =>
      respond({
        type: `${ClusterMessageTypes.REPLICATION_FACTOR}.error`,
        sourceId: nodeId,
        requestId: message.requestId,
        payload: encodeRefusal(error),
      }).catch(() => {}),
  )
}
