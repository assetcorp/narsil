import { decode } from '@msgpack/msgpack'
import type { ClusterCoordinator } from '../coordinator/types'
import type { InsyncConfirmPayload, InsyncRemovePayload, NodeTransport } from '../transport/types'
import { createInsyncRemoveMessage, validateInsyncConfirmPayload } from './codec'

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
  const table = await coordinator.getAllocation(payload.indexName)
  if (table === null) {
    return {
      indexName: payload.indexName,
      partitionId: payload.partitionId,
      accepted: false,
    }
  }

  const assignment = table.assignments.get(payload.partitionId)
  if (assignment === undefined) {
    return {
      indexName: payload.indexName,
      partitionId: payload.partitionId,
      accepted: false,
    }
  }

  if (payload.primaryTerm !== assignment.primaryTerm) {
    return {
      indexName: payload.indexName,
      partitionId: payload.partitionId,
      accepted: false,
    }
  }

  const updatedInSyncSet = assignment.inSyncSet.filter(nodeId => nodeId !== payload.replicaNodeId)

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

  const written = await coordinator.putAllocation(payload.indexName, updatedTable, table.version)

  return {
    indexName: payload.indexName,
    partitionId: payload.partitionId,
    accepted: written,
  }
}
