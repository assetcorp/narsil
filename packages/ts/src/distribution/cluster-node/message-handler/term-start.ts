import { createTermStartAckMessage, validateTermStartPayload } from '../../replication/term-start-codec'
import type { RespondFn, TransportMessage } from '../../transport/types'
import { noteAcceptedPrimaryTerm, noteSupersedingPrimary } from '../led-term'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import { resolveValidatedAssignment } from './entry-authority'
import type { DataNodeHandlerDeps } from './types'
import { refuseAnotherIndex } from './writes'

export async function handleTermStart(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const request = validateTermStartPayload(message.payload)
  const { indexName, partitionId, primaryTerm } = request
  refuseAnotherIndex(indexName, request.indexUuid, deps)
  await resolveValidatedAssignment({ indexName, partitionId, primaryTerm }, message.sourceId, deps)
  noteSupersedingPrimary(
    deps.writeDeps.getReplicationLog(indexName, partitionId),
    indexName,
    partitionId,
    message.sourceId,
    primaryTerm,
  )
  const held = await enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, indexName, partitionId, async () => {
    const log = deps.writeDeps.getReplicationLog(indexName, partitionId)
    noteAcceptedPrimaryTerm(log, primaryTerm)
    const lastSeqNo = log.localLogEnd
    return { lastSeqNo, lastPrimaryTerm: lastSeqNo === 0 ? 0 : (log.termAt(lastSeqNo) ?? 0) }
  })
  await respond(createTermStartAckMessage({ indexName, partitionId, ...held }, deps.nodeId, message.requestId))
}
