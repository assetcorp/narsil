import { pause } from '../../cluster/rebalance/pause'
import type { PartitionAssignment } from '../../coordinator/types'
import { withoutRemovedReplicas } from '../catch-up/admitted'
import {
  admissionGenerationIs,
  admissionGenerationOf,
  feedsReplica,
  type OutOfStepRemoval,
  partitionKey,
} from '../catch-up/state'
import { OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS, OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS } from '../constants'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { PrimaryWriteScope } from './numbered-write'
import { controllerForRemoval, removeReplicaFromInsync } from './replication'
import { leadingAssignment, lostTerm } from './rollback'

export interface OutOfStepCopy {
  replicaNodeId: string
  generation: number
}

interface PendingCopies {
  copies: OutOfStepCopy[]
}

function termOf(scope: PrimaryWriteScope) {
  return { indexName: scope.indexName, partitionId: scope.partitionId, primaryTerm: scope.assignment.primaryTerm }
}

export function claimOutOfStepRemoval(scope: PrimaryWriteScope): OutOfStepRemoval | undefined {
  const { catchUp } = scope.deps
  const key = partitionKey(scope.indexName, scope.partitionId)
  const current = catchUp.outOfStepRemovals.get(key)
  if (current !== undefined && current.primaryTerm > scope.assignment.primaryTerm) return undefined
  const removal: OutOfStepRemoval = { primaryTerm: scope.assignment.primaryTerm }
  catchUp.outOfStepRemovals.set(key, removal)
  return removal
}

function releaseOutOfStepRemoval(scope: PrimaryWriteScope, removal: OutOfStepRemoval): void {
  const { catchUp } = scope.deps
  const key = partitionKey(scope.indexName, scope.partitionId)
  if (catchUp.outOfStepRemovals.get(key) === removal) catchUp.outOfStepRemovals.delete(key)
}

export function outOfStepCopyOf(scope: PrimaryWriteScope, replicaNodeId: string): OutOfStepCopy {
  const { deps, indexName, partitionId } = scope
  return { replicaNodeId, generation: admissionGenerationOf(deps.catchUp, indexName, partitionId, replicaNodeId) }
}

export async function removeOutOfStepCopies(
  scope: PrimaryWriteScope,
  removal: OutOfStepRemoval,
  copies: OutOfStepCopy[],
): Promise<void> {
  const pending: PendingCopies = { copies }
  let settled = true
  try {
    settled = await attemptRemoval(scope, removal, pending, false)
  } catch (error) {
    settled = lostTerm(error)
  }
  if (settled || abandoned(scope, removal)) {
    releaseOutOfStepRemoval(scope, removal)
    return
  }
  void keepRemoving(scope, pending, removal)
    .catch(() => undefined)
    .finally(() => releaseOutOfStepRemoval(scope, removal))
}

function abandoned(scope: PrimaryWriteScope, removal: OutOfStepRemoval): boolean {
  const { deps, indexName, partitionId } = scope
  return (
    deps.stopped?.() === true ||
    deps.catchUp.stopped ||
    deps.catchUp.outOfStepRemovals.get(partitionKey(indexName, partitionId)) !== removal
  )
}

function admittedSince(scope: PrimaryWriteScope, copy: OutOfStepCopy): boolean {
  const { deps, indexName, partitionId } = scope
  return !admissionGenerationIs(deps.catchUp, indexName, partitionId, copy.replicaNodeId, copy.generation)
}

function removable(scope: PrimaryWriteScope, copy: OutOfStepCopy): boolean {
  const { deps, indexName, partitionId } = scope
  return !admittedSince(scope, copy) && !feedsReplica(deps.catchUp, indexName, partitionId, copy.replicaNodeId)
}

function stillInSync(scope: PrimaryWriteScope, current: PartitionAssignment, copies: OutOfStepCopy[]): OutOfStepCopy[] {
  const { deps, indexName, partitionId } = scope
  const inSync = withoutRemovedReplicas(
    deps.catchUp,
    indexName,
    partitionId,
    current.primaryTerm,
    copies.map(copy => copy.replicaNodeId).filter(replicaNodeId => current.inSyncSet.includes(replicaNodeId)),
  )
  return copies.filter(copy => inSync.includes(copy.replicaNodeId))
}

async function tryRemoval(
  scope: PrimaryWriteScope,
  pending: PendingCopies,
  refresh: boolean,
  live: () => boolean,
): Promise<boolean> {
  if (!live()) return false
  pending.copies = pending.copies.filter(copy => !admittedSince(scope, copy))
  if (refresh && pending.copies.length > 0) {
    const current = await leadingAssignment(scope)
    if (!live()) return false
    pending.copies = stillInSync(scope, current, pending.copies)
  }
  let controllerNodeId: string | undefined
  for (const copy of [...pending.copies]) {
    if (!removable(scope, copy)) continue
    if (controllerNodeId === undefined) {
      controllerNodeId = await controllerForRemoval(
        termOf(scope),
        pending.copies.map(other => other.replicaNodeId),
        scope.deps,
      )
      if (!live()) return false
      if (!removable(scope, copy)) continue
    }
    const wanted = () => live() && removable(scope, copy)
    await removeReplicaFromInsync(
      termOf(scope),
      copy.replicaNodeId,
      controllerNodeId,
      copy.generation,
      scope.deps,
      wanted,
    )
    if (!live()) return false
    pending.copies = pending.copies.filter(other => other !== copy)
  }
  pending.copies = pending.copies.filter(copy => !admittedSince(scope, copy))
  return pending.copies.length === 0
}

async function attemptRemoval(
  scope: PrimaryWriteScope,
  removal: OutOfStepRemoval,
  pending: PendingCopies,
  refresh: boolean,
): Promise<boolean> {
  const timeoutMs = replicationTimeoutOf(scope.deps)
  let open = true
  try {
    return await withinDeadline(
      tryRemoval(scope, pending, refresh, () => open && !abandoned(scope, removal)),
      timeoutMs,
      () => new Error(`A try to remove out-of-step copies did not finish within ${timeoutMs}ms`),
    )
  } finally {
    open = false
  }
}

async function keepRemoving(
  scope: PrimaryWriteScope,
  pending: PendingCopies,
  removal: OutOfStepRemoval,
): Promise<void> {
  let delayMs = OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS
  for (;;) {
    await pause(delayMs)
    if (abandoned(scope, removal)) return
    try {
      if (await attemptRemoval(scope, removal, pending, true)) return
    } catch (error) {
      if (lostTerm(error)) return
    }
    delayMs = Math.min(delayMs * 2, OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS)
  }
}
