import { decode, encode } from '@msgpack/msgpack'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import { isRecord, isValidInteger } from '../../payload-guards'
import type {
  BootstrapCompletePayload,
  BootstrapCompleteResultPayload,
  RespondFn,
  TransportMessage,
} from '../../transport/types'
import { ClusterMessageTypes } from '../../transport/types'

/**
 * Reads a bootstrap completion report out of a decoded payload, and reports a malformed one as `null`.
 *
 * @param decoded - The decoded message payload.
 * @returns The validated payload, or `null` when a field is missing or holds the wrong type.
 */
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

/**
 * Rejects a bootstrap completion report without reading the allocation table.
 *
 * The controller answers this way when it no longer holds the controller lease, so that the reporting node learns
 * the outcome at once and retries against whichever node took over.
 *
 * @param message - The report the node sent.
 * @param respond - The function that returns the result to the reporting node.
 * @param controllerNodeId - This node's own id, which names the sender of the result.
 * @returns A promise that settles once the rejection has been sent.
 */
export async function rejectBootstrapComplete(
  message: TransportMessage,
  respond: RespondFn,
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
  await sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
}

/**
 * Moves a partition to `ACTIVE` on the report of a node that finished its bootstrap, and answers that node.
 *
 * The controller rejects the report unless the sender's own id matches the `nodeId` in the payload, the node is
 * assigned to the partition, the term matches the assignment's term, and the partition is still `INITIALISING`. An
 * accepted report adds the reporting node, and the partition's primary, to the in-sync set.
 *
 * @param message - The report the node sent.
 * @param respond - The function that returns the result to the reporting node.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @param controllerNodeId - The controller's own node id, which names the sender of the result.
 * @returns A promise that settles once the result has been sent.
 */
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
