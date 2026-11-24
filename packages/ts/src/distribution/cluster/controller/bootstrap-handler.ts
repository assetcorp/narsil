import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import { isRecord, isValidInteger } from '../../payload-guards'
import { decodeRequestPayload } from '../../request-decode'
import type {
  BootstrapCompletePayload,
  BootstrapCompleteResultPayload,
  RespondFn,
  TransportMessage,
} from '../../transport/types'
import { ClusterMessageTypes } from '../../transport/types'
import { BOOTSTRAP_CAS_ATTEMPTS } from '../constants'
import { putAllocationOver } from '../in-sync-version'
import { encodeRebalanceRefusal } from '../rebalance/reply'
import { rewriteForCurrentIndex } from '../table-identity'

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

async function readBootstrapCompleteOrRefuse(
  message: TransportMessage,
  respond: RespondFn,
  controllerNodeId: string,
): Promise<BootstrapCompletePayload | null> {
  try {
    const payload = validateBootstrapCompletePayload(decodeRequestPayload(message.payload, message.type))
    if (payload !== null) return payload
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid BootstrapCompletePayload: it needs an indexName, a partitionId, a nodeId, and a primaryTerm',
    )
  } catch (error) {
    await respond({
      type: `${message.type}.error`,
      sourceId: controllerNodeId,
      requestId: message.requestId,
      payload: encodeRebalanceRefusal(error),
    })
    return null
  }
}

/**
 * Rejects a bootstrap completion report without reading the allocation table.
 *
 * The controller answers this way when it no longer holds the controller lease, so that the reporting node learns
 * the outcome at once and retries against whichever node took over.
 *
 * @param message - The report the node sent.
 * @param respond - The function that returns the result to the reporting node.
 * @param controllerNodeId - The id of this node, which names the sender of the result.
 * @returns A promise that settles once the rejection has been sent.
 */
export async function rejectBootstrapComplete(
  message: TransportMessage,
  respond: RespondFn,
  controllerNodeId: string,
): Promise<void> {
  const payload = await readBootstrapCompleteOrRefuse(message, respond, controllerNodeId)
  if (payload === null) return
  await sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
}

/**
 * Moves a partition to `ACTIVE` on its primary's report that its copy is ready, and answers the reporting node.
 *
 * The controller rejects the report unless the id of the sender matches the `nodeId` in the payload, the node is the
 * partition's primary, the term matches the assignment's term, and the partition is still `INITIALISING`. A report
 * from a replica, which a node of an earlier release still sends, gets `false`, because the partition serves only once
 * its primary holds a copy, and the primary admits each replica to the in-sync set through the catch-up feed.
 *
 * @param message - The report the node sent.
 * @param respond - The function that returns the result to the reporting node.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @param controllerNodeId - The node id of the controller, which names the sender of the result.
 * @returns A promise that settles once the result has been sent.
 */
export async function handleBootstrapCompleteMessage(
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  controllerNodeId: string,
): Promise<void> {
  const payload = await readBootstrapCompleteOrRefuse(message, respond, controllerNodeId)
  if (payload === null) return

  if (message.sourceId !== payload.nodeId) {
    await sendRejection(respond, controllerNodeId, message.requestId, payload.indexName, payload.partitionId)
    return
  }

  let accepted: boolean
  try {
    accepted = await processBootstrapComplete(payload, coordinator, controllerNodeId)
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

async function processBootstrapComplete(
  payload: BootstrapCompletePayload,
  coordinator: ClusterCoordinator,
  controllerNodeId: string,
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

    if (assignment.primary !== payload.nodeId) {
      return false
    }

    if (assignment.state !== 'INITIALISING') {
      return false
    }

    const served: PartitionAssignment = { ...assignment, state: 'ACTIVE' }
    delete served.lastHolders
    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(payload.partitionId, served)

    const rewritten = await rewriteForCurrentIndex(coordinator, {
      ...table,
      version: table.version + 1,
      assignments: updatedAssignments,
    })
    if (rewritten === null) {
      return false
    }
    const written = await putAllocationOver(coordinator, payload.indexName, table, rewritten, controllerNodeId)
    if (written) {
      return true
    }
  }

  return false
}
