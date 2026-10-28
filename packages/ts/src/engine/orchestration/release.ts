import { ErrorCodes, NarsilError } from '../../errors'
import { cancelIdleMerge } from './compaction'
import { awaitReplicationIdle } from './replication'
import type { OrchestratorState } from './types'

function heldNowhere(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.INDEX_NOT_FOUND
}

export async function releaseIndexCopies(state: OrchestratorState, indexName: string): Promise<boolean> {
  const hold = state.copyReleaseHolds.get(indexName)
  if (hold === undefined) state.copyReleaseHolds.set(indexName, { holders: 1, reloads: false })
  else hold.holders += 1
  state.desyncedIndexes.add(indexName)
  const wasScaledOut = state.scaledOutIndexes.delete(indexName)
  const loading = state.copyTransitions.get(indexName)
  if (loading !== undefined) await loading.done.catch(() => undefined)
  await awaitReplicationIdle(state, indexName)
  cancelIdleMerge(state, indexName)
  const reloads = wasScaledOut || (loading !== undefined && loading.kind !== 'drop')
  const pool = state.workerPool
  if (pool === null) return reloads
  pool.removeIndex(indexName)
  state.segmentLedger.delete(indexName)
  state.unbroadcastSegments.delete(indexName)
  await Promise.all(
    pool.executorEntries().map(({ executor }) =>
      executor.execute({ type: 'dropIndex', indexName, requestId: `restore-release-${indexName}` }).catch(error => {
        if (!heldNowhere(error)) throw error
      }),
    ),
  )
  return reloads
}
