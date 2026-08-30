import type { AllocationTable } from '../../../coordinator/types'
import { abortBootstrapState, bootstrapPartition, createBootstrapState } from '../bootstrap'
import type { NodeLifecycleConfig } from '../types'
import { type AllocationWatcherState, partitionKey } from './state'

export function startBootstrap(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
): void {
  const key = partitionKey(indexName, partitionId)
  const existingBootstrap = state.activeBootstraps.get(key)
  if (existingBootstrap !== undefined) {
    abortBootstrapState(existingBootstrap)
  }

  const bootstrapState = createBootstrapState(indexName, partitionId, primaryNodeId)
  state.activeBootstraps.set(key, bootstrapState)

  bootstrapPartition(
    bootstrapState,
    config.coordinator,
    config.transport,
    config.registration.nodeId,
    config.bootstrapRetryBaseMs,
    config.bootstrapRetryMaxMs,
    config.bootstrapMaxRetries,
    config.onBootstrapPartition,
    config.onError,
  )
    .then(succeeded => {
      if (state.activeBootstraps.get(key) === bootstrapState) {
        state.activeBootstraps.delete(key)
      }
      if (!succeeded) {
        state.trackedPartitions.delete(key)
        void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
      }
    })
    .catch(() => {
      if (state.activeBootstraps.get(key) === bootstrapState) {
        state.activeBootstraps.delete(key)
      }
      state.trackedPartitions.delete(key)
      void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
    })
}

function waitBeforeBootstrapRestart(state: AllocationWatcherState, config: NodeLifecycleConfig): Promise<void> {
  const delayMs = Math.min(config.bootstrapRetryMaxMs, config.bootstrapRetryBaseMs)
  if (delayMs <= 0) {
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      state.restartWaiters.delete(timer)
      resolve()
    }, delayMs)
    timer.unref?.()
    state.restartWaiters.set(timer, resolve)
  })
}

async function restartBootstrapWhileOutOfSync(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
): Promise<void> {
  if (state.stopped) {
    return
  }

  await waitBeforeBootstrapRestart(state, config)
  if (state.stopped) {
    return
  }

  const nodeId = config.registration.nodeId
  let table: AllocationTable | null
  try {
    table = await config.coordinator.getAllocation(indexName)
  } catch (error) {
    if (config.onError !== undefined) {
      config.onError(error)
    }
    if (!state.stopped) {
      void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
    }
    return
  }

  if (state.stopped || table === null) {
    return
  }

  const assignment = table.assignments.get(partitionId)
  if (assignment === undefined || assignment.primary === null || assignment.primary === nodeId) {
    return
  }
  if (!assignment.replicas.includes(nodeId) || assignment.inSyncSet.includes(nodeId)) {
    return
  }
  if (assignment.state !== 'ACTIVE' && assignment.state !== 'INITIALISING' && assignment.state !== 'MIGRATING') {
    return
  }
  if (state.activeBootstraps.has(partitionKey(indexName, partitionId))) {
    return
  }

  startBootstrap(state, config, indexName, partitionId, assignment.primary)
}
