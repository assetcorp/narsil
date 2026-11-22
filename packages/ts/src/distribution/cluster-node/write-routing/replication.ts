import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import { chunkLogEntries } from '../../replication/entry-batches'
import { previousTermOf, replicateBatchToReplicas, replicateToReplicas } from '../../replication/primary'
import type { ReplicationLogEntry } from '../../replication/types'
import { recordAcknowledgements } from '../catch-up/acknowledgements'
import { withTimeout } from '../catch-up/admission'
import {
  admissionToWithdrawOf,
  admittedBeyondTable,
  settleFencedAdmission,
  withoutRemovedReplicas,
  withUnansweredAdmissions,
} from '../catch-up/admitted'
import {
  type AdmissionAnswer,
  type AdmissionToWithdraw,
  clearPendingAdmission,
  getPendingAdmissions,
  type PendingAdmission,
  pendingAdmissionOf,
} from '../catch-up/state'
import { untilSuperseded } from '../led-term'
import { getInSyncReplicaTargets } from './assignment'
import { replicationTimeoutOf } from './deadline'
import { assertPrimaryWriteAuthority, removeFailedReplicasFromInsync } from './insync-removal'
import type { WriteRoutingDeps } from './types'

interface FencedAdmission {
  replicaNodeId: string
  pending: PendingAdmission
  owed: AdmissionToWithdraw | undefined
}

export function appendIndexReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'INDEX',
    partitionId,
    indexName,
    documentId,
    document: encodeDocument(document),
  })
}

export function appendDeleteReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'DELETE',
    partitionId,
    indexName,
    documentId,
    document: null,
  })
}

function replicaTargetsOf(
  entry: ReplicationLogEntry,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): {
  admitted: string[]
  targets: string[]
} {
  const admitted = admittedBeyondTable(deps.catchUp, entry.indexName, entry.partitionId, assignment)
  const pending = getPendingAdmissions(deps.catchUp, entry.indexName, entry.partitionId)
  const targets = withoutRemovedReplicas(
    deps.catchUp,
    entry.indexName,
    entry.partitionId,
    entry.primaryTerm,
    withUnansweredAdmissions(
      deps.catchUp,
      entry.indexName,
      entry.partitionId,
      deps.nodeId,
      getInSyncReplicaTargets(assignment, deps.nodeId, [...pending, ...admitted]),
    ),
  )
  return { admitted, targets }
}

export async function replicateEntry(
  entry: ReplicationLogEntry,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  indexUuid?: string,
): Promise<void> {
  const { admitted, targets: replicaTargets } = replicaTargetsOf(entry, assignment, deps)
  const log = deps.getReplicationLog(entry.indexName, entry.partitionId)
  const result = await untilSuperseded(
    log,
    entry,
    replicateToReplicas(
      entry,
      replicaTargets,
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
      indexUuid,
      previousTermOf(log, entry.seqNo),
    ),
  )
  recordAcknowledgements(deps.catchUp, entry.indexName, entry.partitionId, result.acknowledged, entry.seqNo)
  await removeInSyncFailures(entry, result.failed, assignment, admitted, deps)
  await assertPrimaryWriteAuthority(entry, deps)
  deps.getReplicationLog(entry.indexName, entry.partitionId).advanceCommitPoint(entry.seqNo)
}

async function inSyncFailuresOf(
  entry: ReplicationLogEntry,
  failedReplicas: string[],
  assignment: PartitionAssignment,
  admitted: string[],
  deps: WriteRoutingDeps,
): Promise<{ inSyncFailures: string[]; unanswered: string[]; fenced: FencedAdmission[] }> {
  const inSyncFailures: string[] = []
  const fenced: FencedAdmission[] = []
  const answers: { replicaNodeId: string; answer: Promise<AdmissionAnswer> }[] = []
  const admittedNow = admittedBeyondTable(deps.catchUp, entry.indexName, entry.partitionId, assignment)
  for (const replicaNodeId of failedReplicas) {
    if (
      assignment.inSyncSet.includes(replicaNodeId) ||
      admitted.includes(replicaNodeId) ||
      admittedNow.includes(replicaNodeId)
    ) {
      inSyncFailures.push(replicaNodeId)
      continue
    }
    const pending = pendingAdmissionOf(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId)
    if (pending === undefined) continue
    if (pending.unanswered) {
      inSyncFailures.push(replicaNodeId)
      const owed = admissionToWithdrawOf(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId)
      fenced.push({ replicaNodeId, pending, owed })
      continue
    }
    pending.failedWrite = true
    if (pending.answer === null) {
      clearPendingAdmission(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId, pending)
    } else {
      answers.push({ replicaNodeId, answer: pending.answer })
    }
  }
  const timeoutMs = replicationTimeoutOf(deps)
  const settled = await Promise.all(
    answers.map(async ({ replicaNodeId, answer }) => ({
      replicaNodeId,
      answer: await withTimeout<AdmissionAnswer>(answer, timeoutMs, 'unanswered'),
    })),
  )
  const unanswered: string[] = []
  for (const { replicaNodeId, answer } of settled) {
    if (answer === 'accepted') inSyncFailures.push(replicaNodeId)
    if (answer === 'unanswered') unanswered.push(replicaNodeId)
  }
  return { inSyncFailures, unanswered, fenced }
}

async function removeInSyncFailures(
  entry: ReplicationLogEntry,
  failedReplicas: string[],
  assignment: PartitionAssignment,
  admitted: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  const { inSyncFailures, unanswered, fenced } = await inSyncFailuresOf(
    entry,
    failedReplicas,
    assignment,
    admitted,
    deps,
  )
  await removeFailedReplicasFromInsync(entry, inSyncFailures, deps)
  for (const { replicaNodeId, pending, owed } of fenced) {
    settleFencedAdmission(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId, { pending, owed })
  }
  if (unanswered.length === 0) return
  await deps.refreshAllocation?.(entry.indexName)
  await assertPrimaryWriteAuthority(entry, deps)
  const timeoutMs = replicationTimeoutOf(deps)
  throw new NarsilError(
    ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
    `The controller did not answer the admission of ${unanswered.map(nodeId => `'${nodeId}'`).join(', ')} to index '${entry.indexName}' partition ${entry.partitionId} within ${timeoutMs}ms after a failed write, so the primary cannot tell whether to remove it`,
    { indexName: entry.indexName, partitionId: entry.partitionId, unansweredReplicas: unanswered, timeoutMs },
  )
}

export async function replicateEntryBatch(
  entries: ReplicationLogEntry[],
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  indexUuid?: string,
): Promise<void> {
  if (entries.length === 0) {
    return
  }
  const lastEntry = entries[entries.length - 1]
  const { admitted, targets: replicaTargets } = replicaTargetsOf(lastEntry, assignment, deps)
  const log = deps.getReplicationLog(lastEntry.indexName, lastEntry.partitionId)
  const result = await untilSuperseded(
    log,
    lastEntry,
    replicateBatchToReplicas(
      entries,
      replicaTargets,
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
      indexUuid,
      previousTermOf(log, entries[0].seqNo),
    ),
  )
  recordAcknowledgements(deps.catchUp, lastEntry.indexName, lastEntry.partitionId, result.acknowledged, lastEntry.seqNo)
  await removeInSyncFailures(lastEntry, result.failed, assignment, admitted, deps)
  await assertPrimaryWriteAuthority(lastEntry, deps)
  deps.getReplicationLog(lastEntry.indexName, lastEntry.partitionId).advanceCommitPoint(lastEntry.seqNo)
}

export function chunkReplicationEntries<T extends { entry: ReplicationLogEntry }>(items: T[]): T[][] {
  return chunkLogEntries(items, item => item.entry)
}
