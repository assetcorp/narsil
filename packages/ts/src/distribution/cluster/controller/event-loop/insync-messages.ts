import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator } from '../../../coordinator/types'
import { createInsyncConfirmMessage } from '../../../replication/codec'
import { handleInsyncAdmission, handleInsyncRemoval } from '../../../replication/insync'
import type {
  InsyncAddPayload,
  InsyncConfirmPayload,
  InsyncRemovePayload,
  RespondFn,
  TransportMessage,
} from '../../../transport/types'
import { handleBootstrapCompleteMessage } from '../bootstrap-handler'
import type { EventLoopState } from './state'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

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
  state.insyncQueue = state.insyncQueue.then(task).catch(() => {
    /* The primary retries on its next tick, or rereads the allocation for the current one. */
  })
}

export function handleInsyncRemoveMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
): void {
  const payload = validateInsyncRemovePayload(decodeMessage(message))
  if (payload === null) {
    return
  }

  enqueue(state, async () => {
    if (!(await assertSenderLeadsPartition(coordinator, payload.indexName, payload.partitionId, message.sourceId))) {
      return
    }
    const confirmPayload = await handleInsyncRemoval(payload, coordinator)
    await respond(createInsyncConfirmMessage(confirmPayload, nodeId, message.requestId))
  })
}

export function handleInsyncAddMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
): void {
  const payload = validateInsyncAddPayload(decodeMessage(message))
  if (payload === null) {
    return
  }

  enqueue(state, async () => {
    let confirmPayload: InsyncConfirmPayload
    if (await assertSenderLeadsPartition(coordinator, payload.indexName, payload.partitionId, message.sourceId)) {
      confirmPayload = await handleInsyncAdmission(payload, coordinator)
    } else {
      confirmPayload = { indexName: payload.indexName, partitionId: payload.partitionId, accepted: false }
    }
    await respond(createInsyncConfirmMessage(confirmPayload, nodeId, message.requestId))
  })
}

export function handleQueuedBootstrapComplete(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
): void {
  enqueue(state, () => handleBootstrapCompleteMessage(message, respond, coordinator, nodeId))
}
