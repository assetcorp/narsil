import type { ClusterCoordinator, PartitionAssignment } from '../../../coordinator/types'
import { isRecord, isValidInteger } from '../../../payload-guards'
import { createInsyncConfirmMessage } from '../../../replication/codec'
import { INSYNC_CAS_ATTEMPTS } from '../../../replication/constants'
import type { PrimaryResignPayload, RespondFn, TransportMessage } from '../../../transport/types'
import { handleLostNodes } from '../../allocator/lost-nodes'
import { getIndexMetadata } from '../../index-metadata'
import { rewriteForCurrentIndex } from '../../table-identity'
import { scheduleDebouncedAllocation } from './allocation'
import { decodeMessage, describeRequest, enqueue, respondRefusal } from './insync-messages'
import type { EventLoopState } from './state'

export function validatePrimaryResignPayload(decoded: unknown): PrimaryResignPayload | null {
  if (!isRecord(decoded)) return null
  if (typeof decoded.indexName !== 'string' || typeof decoded.indexUuid !== 'string') return null
  if (!isValidInteger(decoded.partitionId) || !isValidInteger(decoded.primaryTerm)) return null
  return {
    indexName: decoded.indexName,
    indexUuid: decoded.indexUuid,
    partitionId: decoded.partitionId,
    primaryTerm: decoded.primaryTerm,
  }
}

function failedOver(
  assignment: PartitionAssignment,
  resigningNodeId: string,
  registeredNodeIds: ReadonlySet<string>,
): PartitionAssignment {
  const copy: PartitionAssignment = {
    ...assignment,
    replicas: [...assignment.replicas],
    inSyncSet: [...assignment.inSyncSet],
  }
  const active = new Set([...registeredNodeIds].filter(nodeId => nodeId !== resigningNodeId))
  handleLostNodes(new Map([[0, copy]]), active, new Set([resigningNodeId]), new Map())
  return copy
}

async function resign(
  payload: PrimaryResignPayload,
  sourceId: string,
  coordinator: ClusterCoordinator,
  controllerNodeId: string,
): Promise<boolean> {
  const metadata = await getIndexMetadata(coordinator, payload.indexName)
  if (metadata === null || metadata.indexUuid !== payload.indexUuid) return false
  for (let attempt = 0; attempt < INSYNC_CAS_ATTEMPTS; attempt++) {
    const table = await coordinator.getAllocation(payload.indexName)
    const assignment = table?.assignments.get(payload.partitionId)
    if (table === null || assignment === undefined) return false
    if (assignment.primary !== sourceId || assignment.primaryTerm !== payload.primaryTerm) return false
    if (assignment.state === 'UNASSIGNED') return false
    const registered = new Set((await coordinator.listNodes()).map(node => node.nodeId))
    const assignments = new Map(table.assignments)
    assignments.set(payload.partitionId, failedOver(assignment, sourceId, registered))
    const rewritten = await rewriteForCurrentIndex(coordinator, { ...table, version: table.version + 1, assignments })
    if (rewritten === null) return false
    if (await coordinator.putAllocation(payload.indexName, rewritten, table.version, controllerNodeId)) return true
  }
  return false
}

export function handlePrimaryResignMessage(
  state: EventLoopState,
  message: TransportMessage,
  respond: RespondFn,
  coordinator: ClusterCoordinator,
  nodeId: string,
  isActive: () => boolean,
  onError?: (indexName: string, error: unknown) => void,
): void {
  const decoded = decodeMessage(message)
  const payload = validatePrimaryResignPayload(decoded)
  if (payload === null) {
    void respondRefusal(respond, describeRequest(decoded), nodeId, message.requestId)
    return
  }

  enqueue(state, async () => {
    const accepted = isActive() && (await resign(payload, message.sourceId, coordinator, nodeId))
    const confirm = { indexName: payload.indexName, partitionId: payload.partitionId, accepted }
    await respond(createInsyncConfirmMessage(confirm, nodeId, message.requestId))
    if (accepted && isActive()) scheduleDebouncedAllocation(state, coordinator, isActive, onError)
  })
}
