import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable } from '../../coordinator/types'
import { nodeRejectionOf, sendToEveryPartition } from '../../query/failover'
import { randomSelector, selectReplicasForQuery } from '../../query/selection'
import type { TransportMessage } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'
import { sendToNode } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'

export interface ClusterReadDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  resolveNodeTargets: (targetNodeId: string) => Promise<string[]>
}

export interface ScatterGroup {
  nodeId: string
  partitionIds: number[]
}

export async function gatherFromEveryPartition<T>(
  allocation: AllocationTable,
  indexName: string,
  read: (group: ScatterGroup) => Promise<T>,
): Promise<T[]> {
  const routing = selectReplicasForQuery(allocation, randomSelector)
  if (routing.unavailablePartitions.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
      `No active replica serves one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: [...routing.unavailablePartitions].sort((a, b) => a - b) },
    )
  }
  const answered = await sendToEveryPartition(routing, (nodeId, partitionIds) => read({ nodeId, partitionIds }))
  return answered.map(answer => answer.result)
}

/**
 * Sends one read request to another node and returns the validated answer.
 *
 * A transport failure becomes a coded {@link NarsilError} that names the target node, and a node answering with an
 * error message raises the code that node sent, so that every read failure reaches the caller as one kind of error
 * whatever went wrong underneath.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param targetNodeId - The node to ask.
 * @param message - The request to send.
 * @param indexName - The index being read, which names the error.
 * @param validate - Reads the answer out of the decoded payload.
 * @returns The validated answer.
 * @throws A {@link NarsilError} where the node could not be reached, timed out, or refused the request.
 */
export async function sendReadRequest<T>(
  deps: ClusterReadDeps,
  targetNodeId: string,
  message: TransportMessage,
  indexName: string,
  validate: (decoded: unknown) => T,
): Promise<T> {
  const response = await sendToNode(deps.config, targetNodeId, message, {
    message: `Node '${targetNodeId}' did not answer a read request for index '${indexName}'`,
    details: { indexName },
  })
  const decoded = decode(response.payload) as Record<string, unknown>
  if (response.type.endsWith('.error') || response.type === 'error' || decoded.error === true) {
    const details = { indexName, targetNodeId }
    throw (
      nodeRejectionOf(decoded.code, decoded.message, details) ??
      new NarsilError(
        typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED,
        typeof decoded.message === 'string'
          ? decoded.message
          : `Node '${targetNodeId}' rejected a read request for index '${indexName}'`,
        details,
      )
    )
  }
  return validate(decoded)
}
