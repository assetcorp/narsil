import type { ClusterCoordinator } from '../coordinator/types'
import { type CopyFailureDeps, type CopyFailures, createCopyFailures } from './copy-failure'
import type { ClusterLocalEngine } from './local-engine'
import { orphanedIndexError, settleLocalIndexes, settleUnreadableIndexes } from './local-index-reconcile'
import { canListCopy, waitForLostCopies } from './lost-copy'

export interface NodeCopiesDeps extends CopyFailureDeps {
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  nodeId: string
  shutdownSignal: AbortSignal
  settleAdopted(indexName: string): Promise<unknown>
  standForElection(): Promise<void>
}

export interface NodeCopies {
  failures: CopyFailures
  isOrphaned(indexName: string): boolean
  assertClaimed(indexName: string): void
  forgetIndex(indexName: string): void
  settle(): Promise<void>
  awaitLostCopies(signal: AbortSignal): Promise<void>
  canList(indexName: string, indexUuid: string | undefined, partitionId: number): Promise<boolean>
}

export function createNodeCopies(deps: NodeCopiesDeps): NodeCopies {
  const { engine, coordinator, nodeId, onError, writeDeps } = deps
  const reconcileDeps = { engine, coordinator, nodeId, onError }
  const orphaned = new Set<string>()
  let unreadable = new Set<string>()
  const isOrphaned = (indexName: string) => orphaned.has(indexName)

  const failures = createCopyFailures(deps)
  writeDeps.copyFailed = failures.isFailed
  writeDeps.failCopy = failures.record
  writeDeps.copyUnlisted = failures.isUnlisted
  writeDeps.stopped = deps.isShutdown
  writeDeps.shutdownSignal = deps.shutdownSignal
  engine.isolateCopyFailures(failures.record)

  return {
    failures,
    isOrphaned,
    assertClaimed(indexName) {
      if (orphaned.has(indexName)) throw orphanedIndexError(nodeId, indexName)
    },
    forgetIndex(indexName) {
      if (engine.listIndexes().some(index => index.name === indexName)) return
      orphaned.delete(indexName)
      unreadable.delete(indexName)
    },
    async settle() {
      unreadable = await settleLocalIndexes(reconcileDeps, orphaned, deps.settleAdopted)
    },
    awaitLostCopies: signal =>
      waitForLostCopies(
        {
          ...reconcileDeps,
          isOrphaned,
          settleUnreadable: () => settleUnreadableIndexes(reconcileDeps, orphaned, unreadable, deps.settleAdopted),
          standForElection: deps.standForElection,
        },
        signal,
      ),
    canList: (indexName, indexUuid, partitionId) =>
      canListCopy({ engine, isOrphaned }, indexName, indexUuid, partitionId),
  }
}
