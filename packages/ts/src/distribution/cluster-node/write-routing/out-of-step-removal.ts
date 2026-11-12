import { pause } from '../../cluster/rebalance/pause'
import type { PartitionAssignment } from '../../coordinator/types'
import { feedsReplica, type OutOfStepRemoval, partitionKey, withoutRemovedReplicas } from '../catch-up/state'
import { OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS, OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS } from '../constants'
import { replicationTimeoutOf, withinDeadline } from './deadline'
import type { PrimaryWriteScope } from './numbered-write'
import { removeFailedReplicasFromInsync } from './replication'
import { leadingAssignment, lostTerm } from './rollback'

function termOf(scope: PrimaryWriteScope) {
  return { indexName: scope.indexName, partitionId: scope.partitionId, primaryTerm: scope.assignment.primaryTerm }
}

export async function removeOutOfStepCopies(scope: PrimaryWriteScope, copies: string[]): Promise<void> {
  if (copies.length === 0) return
  try {
    await removeFailedReplicasFromInsync(termOf(scope), copies, scope.deps)
  } catch (error) {
    if (!lostTerm(error)) retryOutOfStepRemoval(scope, copies)
  }
}

function retryOutOfStepRemoval(scope: PrimaryWriteScope, copies: string[]): void {
  const { catchUp } = scope.deps
  const key = partitionKey(scope.indexName, scope.partitionId)
  const removal: OutOfStepRemoval = { primaryTerm: scope.assignment.primaryTerm }
  catchUp.outOfStepRemovals.set(key, removal)
  void keepRemoving(scope, copies, removal)
    .catch(() => undefined)
    .finally(() => {
      if (catchUp.outOfStepRemovals.get(key) === removal) catchUp.outOfStepRemovals.delete(key)
    })
}

function abandoned(scope: PrimaryWriteScope, removal: OutOfStepRemoval): boolean {
  const { deps, indexName, partitionId } = scope
  return (
    deps.stopped?.() === true ||
    deps.catchUp.stopped ||
    deps.catchUp.outOfStepRemovals.get(partitionKey(indexName, partitionId)) !== removal
  )
}

function stillInSync(scope: PrimaryWriteScope, current: PartitionAssignment, copies: string[]): string[] {
  const { deps, indexName, partitionId } = scope
  const inSync = copies.filter(copy => current.inSyncSet.includes(copy))
  return withoutRemovedReplicas(deps.catchUp, indexName, partitionId, current.primaryTerm, inSync)
}

interface PendingCopies {
  copies: string[]
}

async function tryRemoval(scope: PrimaryWriteScope, pending: PendingCopies): Promise<boolean> {
  const { deps, indexName, partitionId } = scope
  const inSync = stillInSync(scope, await leadingAssignment(scope), pending.copies)
  pending.copies = pending.copies.filter(copy => inSync.includes(copy))
  const unfed = pending.copies.filter(copy => !feedsReplica(deps.catchUp, indexName, partitionId, copy))
  await removeFailedReplicasFromInsync(termOf(scope), unfed, deps)
  return unfed.length === pending.copies.length
}

async function keepRemoving(scope: PrimaryWriteScope, copies: string[], removal: OutOfStepRemoval): Promise<void> {
  const timeoutMs = replicationTimeoutOf(scope.deps)
  const pending: PendingCopies = { copies }
  let delayMs = OUT_OF_STEP_REMOVAL_RETRY_INITIAL_DELAY_MS
  for (;;) {
    await pause(delayMs)
    if (abandoned(scope, removal)) return
    try {
      const settled = await withinDeadline(
        tryRemoval(scope, pending),
        timeoutMs,
        () => new Error(`A try to remove out-of-step copies did not finish within ${timeoutMs}ms`),
      )
      if (settled) return
    } catch (error) {
      if (lostTerm(error)) return
    }
    delayMs = Math.min(delayMs * 2, OUT_OF_STEP_REMOVAL_RETRY_DELAY_CAP_MS)
  }
}
