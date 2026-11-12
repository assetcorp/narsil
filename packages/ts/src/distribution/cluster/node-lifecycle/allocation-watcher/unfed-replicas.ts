import { UNFED_REPLICA_CHECK_INTERVAL_MS, UNFED_REPLICA_RESYNC_MS } from '../../constants'
import type { NodeLifecycleConfig } from '../types'
import { restartBootstrapWhileOutOfSync } from './bootstrap-restart'
import type { AllocationWatcherState } from './state'

export function startUnfedReplicaChecks(state: AllocationWatcherState, config: NodeLifecycleConfig): void {
  const replicaUnfedForMs = config.replicaUnfedForMs
  if (replicaUnfedForMs === undefined || state.unfedReplicaTimer !== null) return
  const timer = setInterval(
    () => resyncUnfedReplicas(state, config, replicaUnfedForMs),
    UNFED_REPLICA_CHECK_INTERVAL_MS,
  )
  timer.unref?.()
  state.unfedReplicaTimer = timer
}

function resyncUnfedReplicas(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  replicaUnfedForMs: (indexName: string, partitionId: number) => number,
): void {
  if (state.stopped) return
  for (const [key, tracked] of state.trackedPartitions) {
    if (tracked.isPrimary || tracked.inSync || tracked.primaryNodeId === null) continue
    if (state.activeBootstraps.has(key) || state.unfedResyncs.has(key)) continue
    if (replicaUnfedForMs(tracked.indexName, tracked.partitionId) < UNFED_REPLICA_RESYNC_MS) continue
    state.unfedResyncs.add(key)
    void restartBootstrapWhileOutOfSync(state, config, tracked.indexName, tracked.partitionId).finally(() => {
      state.unfedResyncs.delete(key)
    })
  }
}
