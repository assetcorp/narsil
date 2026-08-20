import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator } from '../coordinator/types'
import type { InsyncAddPayload, InsyncConfirmPayload, InsyncRemovePayload, NodeTransport } from '../transport/types'
import { createInsyncAddMessage, createInsyncRemoveMessage, validateInsyncConfirmPayload } from './codec'

const INSYNC_CAS_ATTEMPTS = 5

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

export async function handleInsyncRemoval(
  payload: InsyncRemovePayload,
  coordinator: ClusterCoordinator,
): Promise<InsyncConfirmPayload> {
  const refused: InsyncConfirmPayload = {
    indexName: payload.indexName,
    partitionId: payload.partitionId,
    accepted: false,
  }

  for (let attempt = 0; attempt < INSYNC_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(payload.indexName)
    if (table === null) {
      return refused
    }

    const assignment = table.assignments.get(payload.partitionId)
    if (assignment === undefined) {
      return refused
    }

    if (payload.primaryTerm !== assignment.primaryTerm) {
      return refused
    }

    if (!assignment.inSyncSet.includes(payload.replicaNodeId)) {
      return { ...refused, accepted: true }
    }

    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(payload.partitionId, {
      ...assignment,
      inSyncSet: assignment.inSyncSet.filter(nodeId => nodeId !== payload.replicaNodeId),
    })

    const written = await coordinator.putAllocation(
      payload.indexName,
      { ...table, version: table.version + 1, assignments: updatedAssignments },
      table.version,
    )
    if (written) {
      return { ...refused, accepted: true }
    }
  }

  return refused
}

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

export async function handleInsyncAdmission(
  payload: InsyncAddPayload,
  coordinator: ClusterCoordinator,
): Promise<InsyncConfirmPayload> {
  const refused: InsyncConfirmPayload = {
    indexName: payload.indexName,
    partitionId: payload.partitionId,
    accepted: false,
  }

  for (let attempt = 0; attempt < INSYNC_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(payload.indexName)
    if (table === null) {
      return refused
    }

    const assignment = table.assignments.get(payload.partitionId)
    if (assignment === undefined) {
      return refused
    }

    if (payload.primaryTerm !== assignment.primaryTerm) {
      return refused
    }

    if (assignment.state !== 'ACTIVE') {
      return refused
    }

    if (!assignment.replicas.includes(payload.replicaNodeId)) {
      return refused
    }

    if (payload.appliedSeqNo < assignment.commitPoint || payload.appliedSeqNo < payload.commitPoint) {
      return refused
    }

    if (assignment.inSyncSet.includes(payload.replicaNodeId)) {
      return { ...refused, accepted: true }
    }

    const updatedAssignments = new Map(table.assignments)
    updatedAssignments.set(payload.partitionId, {
      ...assignment,
      inSyncSet: [...assignment.inSyncSet, payload.replicaNodeId],
      commitPoint: Math.max(assignment.commitPoint, payload.commitPoint),
    })

    const written = await coordinator.putAllocation(
      payload.indexName,
      { ...table, version: table.version + 1, assignments: updatedAssignments },
      table.version,
    )
    if (written) {
      return { ...refused, accepted: true }
    }
  }

  return refused
}
