import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import { MAX_REPLICATION_FACTOR } from '../constants'
import { isRecord, isValidInteger } from '../payload-guards'
import { ClusterMessageTypes, type ReplicationFactorPayload } from '../transport/types'
import { remoteErrorDetails } from './error-reply'
import { sendToNode } from './node-messaging'
import type { ClusterNodeConfig } from './types'

export async function requestReplicationFactor(
  config: ClusterNodeConfig,
  nodeId: string,
  indexName: string,
  replicationFactor: number,
): Promise<void> {
  if (!isValidInteger(replicationFactor) || replicationFactor < 0 || replicationFactor > MAX_REPLICATION_FACTOR) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The replication factor of index '${indexName}' must be an integer from 0 to ${MAX_REPLICATION_FACTOR}`,
      { indexName, replicationFactor: String(replicationFactor) },
    )
  }

  const controllerNodeId = await config.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    throw new NarsilError(
      ErrorCodes.NODE_NOT_CONTROLLER,
      `No node holds the controller lease, so the replication factor of index '${indexName}' stays as it is`,
      { indexName },
    )
  }

  const payload: ReplicationFactorPayload = { indexName, replicationFactor }
  const response = await sendToNode(
    config,
    controllerNodeId,
    {
      type: ClusterMessageTypes.REPLICATION_FACTOR,
      sourceId: nodeId,
      requestId: generateId(),
      payload: encode(payload),
    },
    {
      message: `The controller '${controllerNodeId}' did not answer a replication factor request`,
      details: { indexName },
    },
  )

  const decoded: unknown = decode(response.payload)
  if (!isRecord(decoded)) {
    throw new NarsilError(ErrorCodes.ALLOCATION_FAILED, `The controller sent an unreadable answer for '${indexName}'`, {
      indexName,
      controllerNodeId,
    })
  }
  if (response.type.endsWith('.error') || decoded.error === true) {
    throw new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.ALLOCATION_FAILED,
      typeof decoded.message === 'string' ? decoded.message : `The controller refused the replication factor`,
      { ...remoteErrorDetails(decoded.details), indexName, controllerNodeId },
    )
  }
}
