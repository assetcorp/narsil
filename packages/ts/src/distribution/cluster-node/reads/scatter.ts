import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationTable } from '../../coordinator/types'
import { randomSelector, selectReplicasForQuery } from '../../query/selection'
import {
  TransportError,
  type TransportErrorCode,
  TransportErrorCodes,
  type TransportMessage,
} from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'
import { sendToNode } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'

export interface ClusterReadDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  resolveNodeTargets: (targetNodeId: string) => Promise<string[]>
}

export function servesAnyPartition(allocation: AllocationTable | null): allocation is AllocationTable {
  if (allocation === null || allocation.assignments.size === 0) {
    return false
  }
  for (const [, assignment] of allocation.assignments) {
    if (assignment.state === 'ACTIVE') {
      return true
    }
  }
  return false
}

export async function activeAllocation(deps: ClusterReadDeps, indexName: string): Promise<AllocationTable | null> {
  const allocation = await deps.config.coordinator.getAllocation(indexName)
  return servesAnyPartition(allocation) ? allocation : null
}

export interface ScatterGroup {
  nodeId: string
  partitionIds: number[]
}

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

const READ_FAILURE_BY_TRANSPORT_CODE: Record<TransportErrorCode, string> = {
  [TransportErrorCodes.CONNECT_FAILED]: ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  [TransportErrorCodes.PEER_UNAVAILABLE]: ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  [TransportErrorCodes.TIMEOUT]: ErrorCodes.QUERY_NODE_TIMEOUT,
  [TransportErrorCodes.MESSAGE_TOO_LARGE]: ErrorCodes.QUERY_ROUTING_FAILED,
  [TransportErrorCodes.DECODE_FAILED]: ErrorCodes.QUERY_ROUTING_FAILED,
}

function readFailure(error: unknown, targetNodeId: string, indexName: string): unknown {
  if (error instanceof NarsilError) {
    return error
  }
  if (error instanceof TransportError) {
    return new NarsilError(
      READ_FAILURE_BY_TRANSPORT_CODE[error.code],
      `Node '${targetNodeId}' did not answer a read request for index '${indexName}'`,
      { indexName, targetNodeId, transportCode: error.code },
    )
  }
  return error
}

export async function sendReadRequest<T>(
  deps: ClusterReadDeps,
  targetNodeId: string,
  message: TransportMessage,
  indexName: string,
  validate: (decoded: unknown) => T,
): Promise<T> {
  const response = await sendToNode(deps.config, targetNodeId, message).catch((error: unknown) => {
    throw readFailure(error, targetNodeId, indexName)
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
