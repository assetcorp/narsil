import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import type { InsyncAddPayload, InsyncConfirmPayload, InsyncRemovePayload, NodeTransport } from '../transport/types'
import { createInsyncAddMessage, createInsyncRemoveMessage, validateInsyncConfirmPayload } from './codec'

const INSYNC_CAS_ATTEMPTS = 5

type AssignmentDecision =
  | { outcome: 'refuse' }
  | { outcome: 'accept' }
  | { outcome: 'write'; assignment: PartitionAssignment }

const REFUSE: AssignmentDecision = { outcome: 'refuse' }
const ACCEPT: AssignmentDecision = { outcome: 'accept' }

async function updateInsyncSet(
  request: { indexName: string; partitionId: number; primaryTerm: number },
  coordinator: ClusterCoordinator,
  decide: (assignment: PartitionAssignment) => AssignmentDecision,
): Promise<InsyncConfirmPayload> {
  const refused: InsyncConfirmPayload = {
    indexName: request.indexName,
    partitionId: request.partitionId,
    accepted: false,
  }

  for (let attempt = 0; attempt < INSYNC_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(request.indexName)
    if (table === null) {
      return refused
    }

    const assignment = table.assignments.get(request.partitionId)
    if (assignment === undefined) {
      return refused
    }

    if (request.primaryTerm !== assignment.primaryTerm) {
      return refused
    }

    const decision = decide(assignment)
    if (decision.outcome === 'refuse') {
      return refused
    }
    if (decision.outcome === 'accept') {
      return { ...refused, accepted: true }
    }

    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(request.partitionId, decision.assignment)

    const written = await coordinator.putAllocation(
      request.indexName,
      { ...table, version: table.version + 1, assignments: updatedAssignments },
      table.version,
    )
    if (written) {
      return { ...refused, accepted: true }
    }
  }

  return refused
}

/**
 * Asks the controller to drop a replica from a partition's in-sync set, and reports whether the controller agreed.
 *
 * A primary sends this request when a replica fails to acknowledge a replication entry, and it waits for the answer
 * before it acknowledges the write to the client. See {@link handleInsyncRemoval} for the controller's side.
 *
 * @param indexName - The index whose allocation table the controller updates.
 * @param partitionId - The partition whose in-sync set the controller updates.
 * @param replicaNodeId - The replica the controller removes from the in-sync set.
 * @param primaryTerm - The primary's current term, which the controller compares with the assignment's term.
 * @param controllerNodeId - The node id that the controller lease resolves to.
 * @param transport - The node transport this function sends the request over.
 * @param sourceNodeId - The primary's own node id, which the controller compares with the assignment's primary.
 * @returns An object whose `accepted` field reports whether the controller updated the in-sync set.
 */
export async function requestInsyncRemoval(
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  controllerNodeId: string,
  transport: NodeTransport,
  sourceNodeId: string,
): Promise<{ accepted: boolean }> {
  const payload: InsyncRemovePayload = {
    indexName,
    partitionId,
    replicaNodeId,
    primaryTerm,
  }

  const message = createInsyncRemoveMessage(payload, sourceNodeId)
  const response = await transport.send(controllerNodeId, message)
  const confirmPayload = validateInsyncConfirmPayload(decode(response.payload))

  return { accepted: confirmPayload.accepted }
}

/**
 * Removes a replica from a partition's in-sync set on behalf of the primary that asked, and returns the confirmation
 * the controller sends back.
 *
 * The controller refuses the request when it finds no allocation table, no assignment for the partition, or a
 * `primaryTerm` other than the assignment's own, because a stale primary must not shrink the set. It accepts without
 * a write when the replica is already outside the set, and it otherwise writes the smaller set with a
 * compare-and-set, retrying a lost write a bounded number of times.
 *
 * @param payload - The removal request the primary sent.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @returns The confirmation payload, whose `accepted` field reports whether the in-sync set now excludes the replica.
 */
export function handleInsyncRemoval(
  payload: InsyncRemovePayload,
  coordinator: ClusterCoordinator,
): Promise<InsyncConfirmPayload> {
  return updateInsyncSet(payload, coordinator, assignment => {
    if (!assignment.inSyncSet.includes(payload.replicaNodeId)) {
      return ACCEPT
    }
    return {
      outcome: 'write',
      assignment: {
        ...assignment,
        inSyncSet: assignment.inSyncSet.filter(nodeId => nodeId !== payload.replicaNodeId),
      },
    }
  })
}

/**
 * Asks the controller to admit a caught-up replica to a partition's in-sync set, and reports whether the controller
 * agreed.
 *
 * Only the partition's primary may send this request, and it sends one once the replica's applied position reaches
 * the primary's commit point. See {@link handleInsyncAdmission} for the controller's side.
 *
 * @param payload - The admission request, which names the replica and states both its applied position and the
 *   primary's commit point.
 * @param controllerNodeId - The node id that the controller lease resolves to.
 * @param transport - The node transport this function sends the request over.
 * @param sourceNodeId - The primary's own node id, which the controller compares with the assignment's primary.
 * @returns An object whose `accepted` field reports whether the controller admitted the replica.
 */
export async function requestInsyncAdmission(
  payload: InsyncAddPayload,
  controllerNodeId: string,
  transport: NodeTransport,
  sourceNodeId: string,
): Promise<{ accepted: boolean }> {
  const message = createInsyncAddMessage(payload, sourceNodeId)
  const response = await transport.send(controllerNodeId, message)
  const confirmPayload = validateInsyncConfirmPayload(decode(response.payload))

  return { accepted: confirmPayload.accepted }
}

/**
 * Admits a replica to a partition's in-sync set on behalf of the primary that asked, and returns the confirmation the
 * controller sends back.
 *
 * The controller refuses the request unless the assignment's term matches, the partition is `ACTIVE`, the node is an
 * assigned replica, and the replica's applied position has reached both the stored commit point and the primary's
 * own. It raises the stored commit point to the request's value whenever it accepts, and that value never moves
 * backwards, so a repeated request from a replica that is already in the set still moves the floor forward.
 *
 * @param payload - The admission request the primary sent.
 * @param coordinator - The cluster coordinator that stores the allocation table.
 * @returns The confirmation payload, whose `accepted` field reports whether the in-sync set now holds the replica.
 */
export function handleInsyncAdmission(
  payload: InsyncAddPayload,
  coordinator: ClusterCoordinator,
): Promise<InsyncConfirmPayload> {
  return updateInsyncSet(payload, coordinator, assignment => {
    if (assignment.state !== 'ACTIVE') {
      return REFUSE
    }

    if (!assignment.replicas.includes(payload.replicaNodeId)) {
      return REFUSE
    }

    if (payload.appliedSeqNo < assignment.commitPoint || payload.appliedSeqNo < payload.commitPoint) {
      return REFUSE
    }

    const alreadyInSync = assignment.inSyncSet.includes(payload.replicaNodeId)
    const commitPoint = Math.max(assignment.commitPoint, payload.commitPoint)
    if (alreadyInSync && commitPoint === assignment.commitPoint) {
      return ACCEPT
    }

    return {
      outcome: 'write',
      assignment: {
        ...assignment,
        inSyncSet: alreadyInSync ? assignment.inSyncSet : [...assignment.inSyncSet, payload.replicaNodeId],
        commitPoint,
      },
    }
  })
}
