import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable } from '../../coordinator/types'
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

/**
 * Groups every partition of an index under the node that will read it, and refuses outright where one partition has
 * no active copy.
 *
 * An exact read, such as a count, must cover every partition or report nothing, so this throws rather than returning
 * a group set that would leave a partition unread.
 *
 * @param allocation - The allocation table naming the copy of each partition.
 * @param indexName - The index being read, which names the error.
 * @returns One group for each node, each naming the partitions that node will read.
 * @throws A {@link NarsilError} carrying `QUERY_NO_ACTIVE_REPLICA` where any partition has no active copy.
 */
export function strictScatterGroups(allocation: AllocationTable, indexName: string): ScatterGroup[] {
  const routing = selectReplicasForQuery(allocation, randomSelector)
  if (routing.unavailablePartitions.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
      `No active replica serves one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: [...routing.unavailablePartitions].sort((a, b) => a - b) },
    )
  }
  return Array.from(routing.nodeToPartitions.entries(), ([nodeId, partitionIds]) => ({ nodeId, partitionIds }))
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
    throw new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof decoded.message === 'string'
        ? decoded.message
        : `Node '${targetNodeId}' rejected a read request for index '${indexName}'`,
      { indexName, targetNodeId },
    )
  }
  return validate(decoded)
}
