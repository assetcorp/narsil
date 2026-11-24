import { ErrorCodes, NarsilError } from '../../../errors'
import { previousTermOf, replicateBatchToReplicas } from '../../replication/primary'
import { createTermStartMessage, type TermStartPayload, termStartAckOf } from '../../replication/term-start-codec'
import type { ReplicationLog } from '../../replication/types'
import { type OutOfStepRemoval, partitionKey } from '../catch-up/state'
import { sendThroughTargets } from '../transport-failure'
import { getInSyncReplicaTargets, resolveNodeTargets } from './assignment'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import { removeFailedReplicasFromInsync } from './insync-removal'
import type { PrimaryWriteScope } from './numbered-write'
import {
  claimOutOfStepRemoval,
  copiesLeftOutOfStep,
  type OutOfStepCopy,
  outOfStepCopyOf,
  removeOutOfStepCopies,
} from './out-of-step-removal'
import { chunkReplicationEntries } from './replication'

function releaseStartedTerm(scope: PrimaryWriteScope, previousTerm: number): void {
  const { startedTerms } = scope.deps.catchUp
  const key = partitionKey(scope.indexName, scope.partitionId)
  if (startedTerms.get(key) !== scope.assignment.primaryTerm) return
  if (previousTerm === 0) startedTerms.delete(key)
  else startedTerms.set(key, previousTerm)
}

function startAbandoned(scope: PrimaryWriteScope): boolean {
  const { deps, indexName, partitionId, assignment } = scope
  return (
    deps.stopped?.() === true ||
    deps.catchUp.stopped ||
    deps.catchUp.startedTerms.get(partitionKey(indexName, partitionId)) !== assignment.primaryTerm
  )
}

function abandonedStartError(scope: PrimaryWriteScope): NarsilError {
  const { deps, indexName, partitionId, assignment } = scope
  return new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${deps.nodeId}' stopped serving partition ${partitionId} of index '${indexName}' while it started term ${assignment.primaryTerm}`,
    { indexName, partitionId, localNodeId: deps.nodeId, primaryTerm: assignment.primaryTerm },
  )
}

async function removeUnsettledCopies(scope: PrimaryWriteScope, copies: OutOfStepCopy[], inStep: ReadonlySet<string>) {
  if (startAbandoned(scope)) throw abandonedStartError(scope)
  const { deps, indexName, partitionId, assignment } = scope
  await removeFailedReplicasFromInsync(
    { indexName, partitionId, primaryTerm: assignment.primaryTerm },
    copiesLeftOutOfStep(scope, copies, inStep),
    deps,
  )
}

export async function startTermInQueue(scope: PrimaryWriteScope): Promise<boolean> {
  const { deps, indexName, partitionId, assignment } = scope
  const key = partitionKey(indexName, partitionId)
  const previousTerm = deps.catchUp.startedTerms.get(key) ?? 0
  if (previousTerm >= assignment.primaryTerm) return false
  deps.catchUp.startedTerms.set(key, assignment.primaryTerm)
  const replicaNodeIds = getInSyncReplicaTargets(assignment, deps.nodeId)
  if (replicaNodeIds.length === 0) return false
  const copies = replicaNodeIds.map(replicaNodeId => outOfStepCopyOf(scope, replicaNodeId))
  const inStep = new Set<string>()
  const removal = claimOutOfStepRemoval(scope)
  const work = startTermOnCopies(scope, copies, inStep, removal).catch(() => undefined)
  await withinDeadline(work, replicationTimeoutOf(deps), () => new Error('The term start outlasted its hold')).catch(
    () => undefined,
  )
  try {
    await removeUnsettledCopies(scope, copies, inStep)
  } catch (error) {
    releaseStartedTerm(scope, previousTerm)
    throw error
  }
  return true
}

async function startTermOnCopies(
  scope: PrimaryWriteScope,
  copies: OutOfStepCopy[],
  inStep: Set<string>,
  removal: OutOfStepRemoval | undefined,
): Promise<void> {
  let outOfStep: OutOfStepCopy[] = []
  try {
    outOfStep = await settleCopies(scope, copies, inStep)
  } finally {
    if (removal !== undefined) await removeOutOfStepCopies(scope, removal, outOfStep)
  }
}

async function settleCopies(
  scope: PrimaryWriteScope,
  copies: OutOfStepCopy[],
  inStep: Set<string>,
): Promise<OutOfStepCopy[]> {
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
  const settled = await Promise.all(
    copies.map(async copy => {
      const settledInStep = await settleCopy(scope, log, request, copy.replicaNodeId).catch(() => false)
      if (settledInStep) inStep.add(copy.replicaNodeId)
      return settledInStep ? null : copy
    }),
  )
  return settled.filter(copy => copy !== null)
}

export interface CopyEnd {
  lastSeqNo: number
  lastPrimaryTerm: number
}

export async function bringCopyToEnd(scope: PrimaryWriteScope, copy: string): Promise<CopyEnd | null> {
  const { deps, indexName, partitionId, assignment } = scope
  const log = deps.getReplicationLog(indexName, partitionId)
  const lastSeqNo = log.localLogEnd
  const lastPrimaryTerm = lastSeqNo === 0 ? 0 : log.termAt(lastSeqNo)
  if (lastPrimaryTerm === undefined) return null
  const request: TermStartPayload = {
    indexName,
    partitionId,
    primaryTerm: assignment.primaryTerm,
    lastSeqNo,
    lastPrimaryTerm,
  }
  if (scope.indexUuid !== undefined) request.indexUuid = scope.indexUuid
  const inStep = await settleCopy(scope, log, request, copy).catch(() => false)
  return inStep ? { lastSeqNo, lastPrimaryTerm } : null
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
