import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { AnyDocument } from '../../../types/schema'
import { chunkByBudget } from '../../chunking'
import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import { WIRE_BATCH_BUDGET } from '../../constants'
import type { PartitionAssignment } from '../../coordinator/types'
import { requestInsyncRemoval } from '../../replication/insync'
import { previousTermOf, replicateBatchToReplicas, replicateToReplicas } from '../../replication/primary'
import type { ReplicationLogEntry } from '../../replication/types'
import { recordAcknowledgements } from '../catch-up/acknowledgements'
import { withTimeout } from '../catch-up/admission'
import {
  admissionToWithdrawOf,
  admittedBeyondTable,
  recordRemovalUnlessReadmitted,
  settleFencedAdmission,
  withoutRemovedReplicas,
} from '../catch-up/admitted'
import {
  type AdmissionAnswer,
  type AdmissionToWithdraw,
  admissionGenerationOf,
  clearPendingAdmission,
  getPendingAdmissions,
  type PendingAdmission,
  pendingAdmissionOf,
} from '../catch-up/state'
import { untilSuperseded } from '../led-term'
import { sendThroughTargets } from '../transport-failure'
import { getInSyncReplicaTargets, resolveNodeTargets } from './assignment'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { WriteRoutingDeps } from './types'

type TermScope = Pick<ReplicationLogEntry, 'indexName' | 'partitionId' | 'primaryTerm'>

interface FencedAdmission {
  replicaNodeId: string
  pending: PendingAdmission
  owed: AdmissionToWithdraw | undefined
}

export async function assertPrimaryWriteAuthority(entry: TermScope, deps: WriteRoutingDeps): Promise<void> {
  const table = await deps.coordinator.getAllocation(entry.indexName)
  const currentAssignment = table?.assignments.get(entry.partitionId)
  const currentPrimaryNodeId = currentAssignment?.primary ?? null
  const currentPrimaryTerm = currentAssignment?.primaryTerm ?? null

  if (currentPrimaryNodeId === deps.nodeId && currentPrimaryTerm === entry.primaryTerm) {
    return
  }

  throw new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Primary authority changed before acknowledging write for index '${entry.indexName}' partition ${entry.partitionId}`,
    {
      indexName: entry.indexName,
      partitionId: entry.partitionId,
      localNodeId: deps.nodeId,
      expectedPrimaryTerm: entry.primaryTerm,
      currentPrimaryNodeId,
      currentPrimaryTerm,
    },
  )
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

export async function removeFailedReplicasFromInsync(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  if (failedReplicas.length === 0) {
    return
  }
  const timeoutMs = replicationTimeoutOf(deps)
  await withinDeadline(
    removeEachFailedReplica(entry, failedReplicas, deps),
    timeoutMs,
    () =>
      new NarsilError(
        ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
        `Removing failed replicas from the in-sync set of index '${entry.indexName}' partition ${entry.partitionId} did not finish within ${timeoutMs}ms`,
        { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas, timeoutMs },
      ),
  )
}

async function removeEachFailedReplica(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  const controllerNodeId = await controllerForRemoval(entry, failedReplicas, deps)
  for (const replicaNodeId of failedReplicas) {
    const generationAtRemoval = admissionGenerationOf(deps.catchUp, entry.indexName, entry.partitionId, replicaNodeId)
    await removeReplicaFromInsync(entry, replicaNodeId, controllerNodeId, generationAtRemoval, deps)
  }
}

export async function controllerForRemoval(
  entry: TermScope,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<string> {
  const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId !== null) return controllerNodeId
  await deps.refreshAllocation?.(entry.indexName)
  await assertPrimaryWriteAuthority(entry, deps)
  throw new NarsilError(
    ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
    `Failed to remove replicas from in-sync set for index '${entry.indexName}': no active controller lease holder`,
    { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas },
  )
}

export async function removeReplicaFromInsync(
  entry: TermScope,
  replicaNodeId: string,
  controllerNodeId: string,
  generationAtRemoval: number,
  deps: WriteRoutingDeps,
  stillWanted?: () => boolean,
): Promise<void> {
  const accepted = await requestInsyncRemovalWithTargets(
    entry.indexName,
    entry.partitionId,
    replicaNodeId,
    entry.primaryTerm,
    controllerNodeId,
    deps,
    stillWanted,
  )
  if (!accepted) {
    await deps.refreshAllocation?.(entry.indexName)
    await assertPrimaryWriteAuthority(entry, deps)
    throw new NarsilError(
      ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
      `Controller rejected in-sync removal for replica '${replicaNodeId}' of index '${entry.indexName}' partition ${entry.partitionId}`,
      { indexName: entry.indexName, partitionId: entry.partitionId, replicaNodeId },
    )
  }
  recordRemovalUnlessReadmitted(
    deps.catchUp,
    entry.indexName,
    entry.partitionId,
    replicaNodeId,
    entry.primaryTerm,
    generationAtRemoval,
  )
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
    getInSyncReplicaTargets(assignment, deps.nodeId, [...pending, ...admitted]),
  )
  return { admitted, targets }
}

export async function requestInsyncRemovalWithTargets(
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
  stillWanted?: () => boolean,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  const result = await sendThroughTargets(
    targets,
    async target => {
      if (stillWanted?.() === false) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
          `The primary no longer wants replica '${replicaNodeId}' of index '${indexName}' partition ${partitionId} removed from the in-sync set, so it sent no removal request`,
          { indexName, partitionId, replicaNodeId, controllerNodeId },
        )
      }
      return requestInsyncRemoval(
        indexName,
        partitionId,
        replicaNodeId,
        primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
    },
    {
      message: `Controller '${controllerNodeId}' did not answer an in-sync removal request for index '${indexName}' partition ${partitionId}`,
      details: { indexName, partitionId, replicaNodeId, controllerNodeId },
    },
  )
  return result.accepted
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
  return chunkByBudget(items, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: item => item.entry.document?.byteLength ?? 0,
    breaksRun: (item, previous) => item.entry.seqNo !== previous.entry.seqNo + 1,
  })
}
