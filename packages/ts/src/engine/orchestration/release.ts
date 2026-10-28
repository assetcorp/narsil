import type { OrchestratorState } from './types'

export interface CopyReleaseSteps {
  awaitReplicationIdle(state: OrchestratorState, indexName: string): Promise<void>
  cancelIdleMerge(state: OrchestratorState, indexName: string): void
  heldNowhere(error: unknown): boolean
  resyncIndex(indexName: string, wasScaledOut: boolean): Promise<void>
}

export async function releaseIndexCopies(
  state: OrchestratorState,
  indexName: string,
  steps: CopyReleaseSteps,
): Promise<boolean> {
  const wasScaledOut = state.scaledOutIndexes.delete(indexName)
  const loading = state.copyTransitions.get(indexName)
  if (loading !== undefined) await loading.done.catch(() => undefined)
  await steps.awaitReplicationIdle(state, indexName)
  steps.cancelIdleMerge(state, indexName)
  const reloads = wasScaledOut || (loading !== undefined && loading.kind !== 'drop')
  const pool = state.workerPool
  if (pool === null) return reloads
  pool.removeIndex(indexName)
  state.segmentLedger.delete(indexName)
  state.unbroadcastSegments.delete(indexName)
  await Promise.all(
    pool.executorEntries().map(({ executor }) =>
      executor.execute({ type: 'dropIndex', indexName, requestId: `restore-release-${indexName}` }).catch(error => {
        if (!steps.heldNowhere(error)) throw error
      }),
    ),
  )
  return reloads
}

export async function endCopyRelease(
  state: OrchestratorState,
  indexName: string,
  reloads: boolean,
  steps: CopyReleaseSteps,
): Promise<void> {
  const hold = state.copyReleaseHolds.get(indexName)
  if (hold === undefined) return steps.resyncIndex(indexName, reloads)
  hold.holders -= 1
  hold.reloads ||= reloads
  if (hold.holders > 0) return
  state.copyReleaseHolds.delete(indexName)
  await steps.resyncIndex(indexName, hold.reloads)
}
