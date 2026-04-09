import { decode, encode } from '@msgpack/msgpack'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type { BootstrapCompletePayload, BootstrapCompleteResultPayload, TransportMessage } from '../../transport/types'
import { ClusterMessageTypes } from '../../transport/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

export function validateBootstrapCompletePayload(decoded: unknown): BootstrapCompletePayload | null {
  if (!isRecord(decoded)) {
    return null
  }
  if (typeof decoded.indexName !== 'string' || decoded.indexName.length === 0) {
    return null
  }
  if (!isValidInteger(decoded.partitionId) || decoded.partitionId < 0) {
    return null
  }
  if (typeof decoded.nodeId !== 'string') {
    return null
  }
  if (!isValidInteger(decoded.primaryTerm)) {
    return null
  }
  return {
    indexName: decoded.indexName,
    partitionId: decoded.partitionId,
    nodeId: decoded.nodeId,
    primaryTerm: decoded.primaryTerm,
  }
}

function sendRejection(
  respond: (response: TransportMessage) => void,
  controllerNodeId: string,
  requestId: string,
  indexName: string,
  partitionId: number,
): void {
  const resultPayload: BootstrapCompleteResultPayload = {
    indexName,
    partitionId,
    accepted: false,
  }
  const response: TransportMessage = {
    type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
    sourceId: controllerNodeId,
    requestId,
    payload: encode(resultPayload),
  }
  respond(response)
}

export function handleBootstrapCompleteMessage(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  coordinator: ClusterCoordinator,
  controllerNodeId: string,
): void {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    sendRejection(respond, controllerNodeId, message.requestId, '', -1)
    return
  }

  const payload = validateBootstrapCompletePayload(decoded)
  if (payload === null) {
    sendRejection(respond, controllerNodeId, message.requestId, '', -1)
    return
  }

  if (message.sourceId !== payload.nodeId) {
    sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
    return
  }

  processBootstrapComplete(payload, coordinator)
    .then(accepted => {
      const resultPayload: BootstrapCompleteResultPayload = {
        indexName: payload.indexName,
        partitionId: payload.partitionId,
        accepted,
      }
      const response: TransportMessage = {
        type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
        sourceId: controllerNodeId,
        requestId: message.requestId,
        payload: encode(resultPayload),
      }
      respond(response)
    })
    .catch(() => {
      sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
    })
}

function ensurePrimaryInSyncSet(assignment: PartitionAssignment, inSyncSet: string[]): string[] {
  if (assignment.primary === null) {
    return inSyncSet
  }
  if (inSyncSet.includes(assignment.primary)) {
    return inSyncSet
  }
  return [assignment.primary, ...inSyncSet]
}

async function processBootstrapComplete(
  payload: BootstrapCompletePayload,
  coordinator: ClusterCoordinator,
): Promise<boolean> {
  const table = await coordinator.getAllocation(payload.indexName)
  if (table === null) {
    return false
  }

  const assignment = table.assignments.get(payload.partitionId)
  if (assignment === undefined) {
    return false
  }

  if (payload.primaryTerm !== assignment.primaryTerm) {
    return false
  }

  const isAssigned = assignment.primary === payload.nodeId || assignment.replicas.includes(payload.nodeId)

  if (!isAssigned) {
    return false
  }

  if (assignment.state === 'ACTIVE') {
    if (assignment.inSyncSet.includes(payload.nodeId)) {
      return true
    }
    const updatedInSyncSet = [...assignment.inSyncSet, payload.nodeId]
    const updatedAssignment = {
      ...assignment,
      inSyncSet: updatedInSyncSet,
    }
    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(payload.partitionId, updatedAssignment)
    const updatedTable = {
      ...table,
      version: table.version + 1,
      assignments: updatedAssignments,
    }
    return coordinator.putAllocation(payload.indexName, updatedTable, table.version)
  }

  if (assignment.state !== 'INITIALISING') {
    return false
  }

  const baseInSyncSet = assignment.inSyncSet.includes(payload.nodeId)
    ? assignment.inSyncSet
    : [...assignment.inSyncSet, payload.nodeId]
  const updatedInSyncSet = ensurePrimaryInSyncSet(assignment, baseInSyncSet)

  const updatedAssignment = {
    ...assignment,
    state: 'ACTIVE' as const,
    inSyncSet: updatedInSyncSet,
  }

  const updatedAssignments = new Map(table.assignments)
  updatedAssignments.set(payload.partitionId, updatedAssignment)

  const updatedTable = {
    ...table,
    version: table.version + 1,
    assignments: updatedAssignments,
  }

  return coordinator.putAllocation(payload.indexName, updatedTable, table.version)
}
