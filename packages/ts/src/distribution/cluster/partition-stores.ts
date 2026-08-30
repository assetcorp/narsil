import { encode } from '@msgpack/msgpack'
import { isRecord } from '../payload-guards'
import type { PartitionStoresPayload, PartitionStoresResultPayload, TransportMessage } from '../transport/types'
import { ClusterMessageTypes } from '../transport/types'

/**
 * Reads a partition-stores request out of a decoded payload, and reports a malformed one as `null`.
 *
 * @param decoded - The decoded message payload.
 * @returns The validated request, or `null` where the index name is missing or holds the wrong type.
 */
export function validatePartitionStoresPayload(decoded: unknown): PartitionStoresPayload | null {
  if (!isRecord(decoded)) {
    return null
  }
  if (typeof decoded.indexName !== 'string' || decoded.indexName.length === 0) {
    return null
  }
  return { indexName: decoded.indexName }
}

/**
 * Reads a partition-stores answer out of a decoded payload, and reports a malformed one as `null`.
 *
 * @param decoded - The decoded message payload.
 * @returns The validated answer, or `null` where a field is missing, holds the wrong type, or names a partition by
 * something other than a non-negative integer.
 */
export function validatePartitionStoresResultPayload(decoded: unknown): PartitionStoresResultPayload | null {
  if (!isRecord(decoded)) {
    return null
  }
  if (typeof decoded.indexName !== 'string' || decoded.indexName.length === 0) {
    return null
  }
  if (decoded.indexUuid !== null && typeof decoded.indexUuid !== 'string') {
    return null
  }
  if (!Array.isArray(decoded.partitionIds)) {
    return null
  }
  const partitionIds: number[] = []
  for (const partitionId of decoded.partitionIds) {
    if (typeof partitionId !== 'number' || !Number.isInteger(partitionId) || partitionId < 0) {
      return null
    }
    partitionIds.push(partitionId)
  }
  return { indexName: decoded.indexName, indexUuid: decoded.indexUuid, partitionIds }
}

/**
 * Builds the request a controller sends to ask one node which partitions of an index its local copy holds.
 *
 * @param payload - The index the controller asks about.
 * @param sourceNodeId - The controller's own node id, which names the sender.
 * @param requestId - The id that pairs the answer with this request.
 * @returns The message to send over the node transport.
 */
export function createPartitionStoresMessage(
  payload: PartitionStoresPayload,
  sourceNodeId: string,
  requestId: string,
): TransportMessage {
  return {
    type: ClusterMessageTypes.PARTITION_STORES,
    sourceId: sourceNodeId,
    requestId,
    payload: encode(payload),
  }
}

/**
 * Builds the answer a data node returns for a partition-stores request.
 *
 * @param result - The identity of this node's copy and the partitions that copy holds.
 * @param sourceNodeId - The answering node's own id.
 * @param requestId - The id the request carried.
 * @returns The message to send back over the node transport.
 */
export function createPartitionStoresResultMessage(
  result: PartitionStoresResultPayload,
  sourceNodeId: string,
  requestId: string,
): TransportMessage {
  return {
    type: ClusterMessageTypes.PARTITION_STORES,
    sourceId: sourceNodeId,
    requestId,
    payload: encode(result),
  }
}
