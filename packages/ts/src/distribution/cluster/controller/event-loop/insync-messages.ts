import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator } from '../../../coordinator/types'
import { isRecord, isValidInteger } from '../../../payload-guards'
import { createInsyncConfirmMessage } from '../../../replication/codec'
import { handleInsyncAdmission, handleInsyncRemoval } from '../../../replication/insync'
import type {
  InsyncAddPayload,
  InsyncConfirmPayload,
  InsyncRemovePayload,
  RespondFn,
  TransportMessage,
} from '../../../transport/types'
import { handleBootstrapCompleteMessage, rejectBootstrapComplete } from '../bootstrap-handler'
import { scheduleDebouncedAllocation } from './allocation'
import type { EventLoopState } from './state'

const UNKNOWN_PARTITION_ID = -1

/**
 * Reads an in-sync removal request out of a decoded payload, and reports a malformed one as `null`.
 *
 * @param decoded - The decoded message payload.
 * @returns The validated payload, or `null` when a field is missing or holds the wrong type.
 */
export function validateInsyncRemovePayload(decoded: unknown): InsyncRemovePayload | null {
  if (!isRecord(decoded)) {
    return null
  }
  if (typeof decoded.indexName !== 'string') {
    return null
  }
  if (!isValidInteger(decoded.partitionId)) {
    return null
  }
  if (typeof decoded.replicaNodeId !== 'string') {
    return null
  }
  if (!isValidInteger(decoded.primaryTerm)) {
    return null
  }
  return {
    indexName: decoded.indexName,
    partitionId: decoded.partitionId,
    replicaNodeId: decoded.replicaNodeId,
    primaryTerm: decoded.primaryTerm,
  }
}

/**
 * Reads an in-sync admission request out of a decoded payload, and reports a malformed one as `null`.
 *
 * An admission request holds every field a removal request holds, and it adds the replica's applied position
 * alongside the primary's commit point. Both of those must be non-negative integers.
 *
 * @param decoded - The decoded message payload.
 * @returns The validated payload, or `null` when a field is missing or holds the wrong type.
 */
export function validateInsyncAddPayload(decoded: unknown): InsyncAddPayload | null {
  const base = validateInsyncRemovePayload(decoded)
  if (base === null || !isRecord(decoded)) {
    return null
  }
  if (!isValidInteger(decoded.appliedSeqNo) || decoded.appliedSeqNo < 0) {
    return null
  }
  if (!isValidInteger(decoded.commitPoint) || decoded.commitPoint < 0) {
    return null
  }
  return { ...base, appliedSeqNo: decoded.appliedSeqNo, commitPoint: decoded.commitPoint }
}

function decodeMessage(message: TransportMessage): unknown | null {
  try {
    return decode(message.payload)
  } catch (_) {
    return null
  }
}

function describeRequest(decoded: unknown): { indexName: string; partitionId: number } {
  if (!isRecord(decoded)) {
    return { indexName: '', partitionId: UNKNOWN_PARTITION_ID }
  }
  return {
    indexName: typeof decoded.indexName === 'string' ? decoded.indexName : '',
    partitionId: isValidInteger(decoded.partitionId) ? decoded.partitionId : UNKNOWN_PARTITION_ID,
  }
}

async function assertSenderLeadsPartition(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  sourceId: string,
): Promise<boolean> {
  const table = await coordinator.getAllocation(indexName)
  const assignment = table?.assignments.get(partitionId)
  if (assignment === undefined) {
    return false
  }
  return assignment.primary === sourceId
}

function enqueue(state: EventLoopState, task: () => Promise<void>): void {
  state.insyncQueue = state.insyncQueue.then(task).catch(() => {})
}

async function respondRefusal(
  respond: RespondFn,
  request: { indexName: string; partitionId: number },
  nodeId: string,
  requestId: string,
): Promise<void> {
  const payload: InsyncConfirmPayload = {
    indexName: request.indexName,
    partitionId: request.partitionId,
    accepted: false,
  }
  try {
    await respond(createInsyncConfirmMessage(payload, nodeId, requestId))
  } catch (_) {}
}

/**
 * Answers a primary that asked the controller to drop a replica from a partition's in-sync set.
 *
 * The controller queues the work behind every other in-sync change, so that two changes to one allocation table
 * never race. It refuses the request, rather than leaving the primary waiting for a transport timeout, when the
 * payload fails validation, when the sender does not lead the partition, or when this node has lost leadership
 * while the work waited in the queue.
 *
 * @param state - The event loop state that holds the in-sync queue.
 * @param message - The request the primary sent.
 * @param respond - The function that returns the confirmation to the primary.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @param nodeId - The controller's own node id, which names the sender of the confirmation.
 * @param isActive - Reports whether this node still holds the controller lease.
 */
export function handleInsyncRemoveMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
): void {
  const decoded = decodeMessage(message)
  const payload = validateInsyncRemovePayload(decoded)
  if (payload === null) {
    void respondRefusal(respond, describeRequest(decoded), nodeId, message.requestId)
    return
  }

  enqueue(state, async () => {
    const leadsPartition = await assertSenderLeadsPartition(
      coordinator,
      payload.indexName,
      payload.partitionId,
      message.sourceId,
    )
    if (!leadsPartition || !isActive()) {
      await respondRefusal(respond, payload, nodeId, message.requestId)
      return
    }
    const confirmPayload = await handleInsyncRemoval(payload, coordinator)
    await respond(createInsyncConfirmMessage(confirmPayload, nodeId, message.requestId))
  })
}

/**
 * Answers a primary that asked the controller to admit a caught-up replica to a partition's in-sync set.
 *
 * The controller queues the work behind every other in-sync change, and it refuses the request when the payload
 * fails validation, when the sender does not lead the partition, or when this node has lost leadership while the
 * work waited in the queue. A refusal leaves the replica outside the set, and the primary proposes it again on a
 * later catch-up tick.
 *
 * @param state - The event loop state that holds the in-sync queue.
 * @param message - The request the primary sent.
 * @param respond - The function that returns the confirmation to the primary.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @param nodeId - The controller's own node id, which names the sender of the confirmation.
 * @param isActive - Reports whether this node still holds the controller lease.
 * @param onError - Called with the index name and the error whenever the allocation that follows fails.
 */
export function handleInsyncAddMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): void {
  const decoded = decodeMessage(message)
  const payload = validateInsyncAddPayload(decoded)
  if (payload === null) {
    void respondRefusal(respond, describeRequest(decoded), nodeId, message.requestId)
    return
  }

  enqueue(state, async () => {
    const leadsPartition = await assertSenderLeadsPartition(
      coordinator,
      payload.indexName,
      payload.partitionId,
      message.sourceId,
    )
    if (!leadsPartition || !isActive()) {
      await respondRefusal(respond, payload, nodeId, message.requestId)
      return
    }
    const confirmPayload = await handleInsyncAdmission(payload, coordinator)
    await respond(createInsyncConfirmMessage(confirmPayload, nodeId, message.requestId))

    if (confirmPayload.accepted && isActive()) {
      scheduleDebouncedAllocation(state, coordinator, isActive, onError)
    }
  })
}

/**
 * Answers a node that reported a finished bootstrap, running the work behind every other in-sync change.
 *
 * Moving a partition to `ACTIVE` adds the reporting node to the in-sync set, so it shares the queue with admission
 * and removal. The controller rejects the report when it has lost leadership while the work waited in the queue.
 *
 * @param state - The event loop state that holds the in-sync queue.
 * @param message - The report the node sent.
 * @param respond - The function that returns the result to the reporting node.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @param nodeId - The controller's own node id, which names the sender of the result.
 * @param isActive - Reports whether this node still holds the controller lease.
 */
export function handleQueuedBootstrapComplete(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
): void {
  enqueue(state, () => {
    if (!isActive()) {
      return rejectBootstrapComplete(message, respond, nodeId)
    }
    return handleBootstrapCompleteMessage(message, respond, coordinator, nodeId)
  })
}
