import { previousTermOf, replicateBatchToReplicas } from '../../replication/primary'
import { createTermStartMessage, type TermStartPayload, termStartAckOf } from '../../replication/term-start-codec'
import type { ReplicationLog } from '../../replication/types'
import { partitionKey } from '../catch-up/state'
import { sendThroughTargets } from '../transport-failure'
import { getInSyncReplicaTargets, resolveNodeTargets } from './assignment'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { PrimaryWriteScope } from './numbered-write'
import { chunkReplicationEntries, removeFailedReplicasFromInsync } from './replication'

export async function startTermInQueue(scope: PrimaryWriteScope): Promise<void> {
  const { deps, indexName, partitionId, assignment } = scope
  const key = partitionKey(indexName, partitionId)
  if ((deps.catchUp.startedTerms.get(key) ?? 0) >= assignment.primaryTerm) return
  deps.catchUp.startedTerms.set(key, assignment.primaryTerm)
  const copies = getInSyncReplicaTargets(assignment, deps.nodeId)
  if (copies.length === 0) return
  const work = startTermOnCopies(scope, copies).catch(() => undefined)
  await withinDeadline(work, replicationTimeoutOf(deps), () => new Error('The term start outlasted its hold')).catch(
    () => undefined,
  )
}

async function startTermOnCopies(scope: PrimaryWriteScope, copies: string[]): Promise<void> {
  const { deps, indexName, partitionId, assignment } = scope
  const log = deps.getReplicationLog(indexName, partitionId)
  const lastSeqNo = log.localLogEnd
  const request: TermStartPayload = {
    indexName,
    partitionId,
    primaryTerm: assignment.primaryTerm,
    lastSeqNo,
    lastPrimaryTerm: lastSeqNo === 0 ? 0 : (log.termAt(lastSeqNo) ?? 0),
  }
  if (scope.indexUuid !== undefined) request.indexUuid = scope.indexUuid
  const inStep = await Promise.all(copies.map(copy => settleCopy(scope, log, request, copy).catch(() => false)))
  const removed = copies.filter((_, at) => !inStep[at])
  await removeFailedReplicasFromInsync({ indexName, partitionId, primaryTerm: assignment.primaryTerm }, removed, deps)
}

async function settleCopy(
  scope: PrimaryWriteScope,
  log: ReplicationLog,
  request: TermStartPayload,
  copy: string,
): Promise<boolean> {
  const { deps } = scope
  const message = createTermStartMessage(request, deps.nodeId)
  const response = await sendThroughTargets(
    await resolveNodeTargets(copy, deps),
    target => deps.transport.send(target, message),
    {
      message: `Node '${copy}' did not answer the start of term ${request.primaryTerm}`,
      details: { indexName: request.indexName, partitionId: request.partitionId, replicaNodeId: copy },
    },
  )
  const answer = termStartAckOf(response, request)
  if (answer === null) return false
  if (answer.lastSeqNo === request.lastSeqNo && answer.lastPrimaryTerm === request.lastPrimaryTerm) return true
  if (answer.lastSeqNo >= request.lastSeqNo) return false
  const termHere = answer.lastSeqNo === 0 ? 0 : log.termAt(answer.lastSeqNo)
  if (termHere !== answer.lastPrimaryTerm) return false
  return sendMissingEntries(scope, log, copy, answer.lastSeqNo)
}

async function sendMissingEntries(
  scope: PrimaryWriteScope,
  log: ReplicationLog,
  copy: string,
  heldSeqNo: number,
): Promise<boolean> {
  const { deps } = scope
  const missing = log.getEntriesFrom(heldSeqNo + 1)
  if (missing[0]?.seqNo !== heldSeqNo + 1) return false
  for (const chunk of chunkReplicationEntries(missing.map(entry => ({ entry })))) {
    const entries = chunk.map(item => item.entry)
    const first = entries[0]
    if (first === undefined) continue
    const result = await replicateBatchToReplicas(
      entries,
      [copy],
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
      scope.indexUuid,
      previousTermOf(log, first.seqNo),
    )
    if (!result.acknowledged.includes(copy)) return false
  }
  return true
}
