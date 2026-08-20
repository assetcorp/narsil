import { decode, encode } from '@msgpack/msgpack'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type {
  BootstrapCompletePayload,
  BootstrapCompleteResultPayload,
  RespondFn,
  TransportMessage,
} from '../../transport/types'
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

async function sendRejection(
  respond: RespondFn,
  controllerNodeId: string,
  requestId: string,
  indexName: string,
  partitionId: number,
): Promise<void> {
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
  await respond(response)
}

export async function handleBootstrapCompleteMessage(
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  controllerNodeId: string,
): Promise<void> {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    await sendRejection(respond, controllerNodeId, message.requestId, '', -1)
    return
  }

  const payload = validateBootstrapCompletePayload(decoded)
  if (payload === null) {
    await sendRejection(respond, controllerNodeId, message.requestId, '', -1)
    return
  }

  if (message.sourceId !== payload.nodeId) {
    await sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
    return
  }

  let accepted: boolean
  try {
    accepted = await processBootstrapComplete(payload, coordinator)
  } catch (_) {
    await sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
    return
  }

  const resultPayload: BootstrapCompleteResultPayload = {
    indexName: payload.indexName,
    partitionId: payload.partitionId,
    accepted,
  }
  await respond({
    type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
    sourceId: controllerNodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

const BOOTSTRAP_CAS_ATTEMPTS = 5

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
  for (let attempt = 0; attempt < BOOTSTRAP_CAS_ATTEMPTS; attempt++) {
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

    if (assignment.primary !== payload.nodeId && !assignment.replicas.includes(payload.nodeId)) {
      return false
    }

    if (assignment.state !== 'INITIALISING') {
      return false
    }

    const baseInSyncSet = assignment.inSyncSet.includes(payload.nodeId)
      ? assignment.inSyncSet
      : [...assignment.inSyncSet, payload.nodeId]

    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(payload.partitionId, {
      ...assignment,
      state: 'ACTIVE' as const,
      inSyncSet: ensurePrimaryInSyncSet(assignment, baseInSyncSet),
    })

    const written = await coordinator.putAllocation(
      payload.indexName,
      { ...table, version: table.version + 1, assignments: updatedAssignments },
      table.version,
    )
    if (written) {
      return true
    }
  }

  return false
}
