import { ADMISSION_TIMEOUT_MS } from '../../../cluster-node/constants'
import type { AllocationTable } from '../../../coordinator/types'
import { PRIMARY_BOOTSTRAP_RESTART_DELAY_MS } from '../../constants'
import { abortBootstrapState, bootstrapPartition, createBootstrapState } from '../bootstrap'
import type { NodeLifecycleConfig } from '../types'
import { type AllocationWatcherState, forgetAwaitedAdmission, partitionKey } from './state'

export function startBootstrap(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  primaryTerm: number,
): void {
  const key = partitionKey(indexName, partitionId)
  forgetAwaitedAdmission(state, key)
  const existingBootstrap = state.activeBootstraps.get(key)
  if (existingBootstrap !== undefined) {
    abortBootstrapState(existingBootstrap)
  }

  const bootstrapState = createBootstrapState(indexName, partitionId, primaryNodeId)
  state.activeBootstraps.set(key, bootstrapState)
  if (!state.trackedPartitions.has(key)) {
    state.trackedPartitions.set(key, {
      indexName,
      partitionId,
      isPrimary: primaryNodeId === config.registration.nodeId,
      primaryNodeId,
      primaryTerm,
      inSync: false,
    })
  }

  const settle = (succeeded: boolean): void => {
    if (state.activeBootstraps.get(key) !== bootstrapState) {
      return
    }
    state.activeBootstraps.delete(key)
    if (state.stopped) {
      return
    }
    const syncsReplica = primaryNodeId !== config.registration.nodeId
    if (succeeded) {
      if (syncsReplica) {
        awaitAdmission(state, config, indexName, partitionId, primaryNodeId, primaryTerm)
      }
      return
    }
    forgetAwaitedAdmission(state, key)
    if (syncsReplica) {
      void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
    } else {
      void restartBootstrapWhilePrimaryInitialising(state, config, indexName, partitionId)
    }
  }

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
    .then(settle)
    .catch(() => settle(false))
}

function awaitAdmission(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  primaryTerm: number,
): void {
  const key = partitionKey(indexName, partitionId)
  const tracked = state.trackedPartitions.get(key)
  if (state.stopped || tracked === undefined || tracked.inSync) {
    return
  }
  if (tracked.primaryNodeId !== primaryNodeId || tracked.primaryTerm !== primaryTerm) {
    void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
    return
  }
  const timer = setTimeout(() => {
    if (state.awaitedAdmissions.get(key)?.timer !== timer) {
      return
    }
    state.awaitedAdmissions.delete(key)
    void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
  }, ADMISSION_TIMEOUT_MS)
  timer.unref?.()
  state.awaitedAdmissions.set(key, { primaryNodeId, primaryTerm, timer })
}

function waitBeforeBootstrapRestart(state: AllocationWatcherState, delayMs: number): Promise<void> {
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

export async function restartBootstrapWhileOutOfSync(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
): Promise<void> {
  if (state.stopped) {
    return
  }

  await waitBeforeBootstrapRestart(state, Math.min(config.bootstrapRetryMaxMs, config.bootstrapRetryBaseMs))
  if (state.stopped) {
    return
  }

  const nodeId = config.registration.nodeId
  let table: AllocationTable | null
  try {
    table = await config.coordinator.getAllocation(indexName)
  } catch (error) {
    if (state.stopped) {
      return
    }
    config.onError?.(error)
    void restartBootstrapWhileOutOfSync(state, config, indexName, partitionId)
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
  const key = partitionKey(indexName, partitionId)
  if (state.activeBootstraps.has(key) || state.awaitedAdmissions.has(key)) {
    return
  }

  startBootstrap(state, config, indexName, partitionId, assignment.primary, assignment.primaryTerm)
}

async function restartBootstrapWhilePrimaryInitialising(
  state: AllocationWatcherState,
  config: NodeLifecycleConfig,
  indexName: string,
  partitionId: number,
): Promise<void> {
  const nodeId = config.registration.nodeId
  while (!state.stopped) {
    await waitBeforeBootstrapRestart(state, PRIMARY_BOOTSTRAP_RESTART_DELAY_MS)
    if (state.stopped) {
      return
    }
    let table: AllocationTable | null
    try {
      table = await config.coordinator.getAllocation(indexName)
    } catch (error) {
      if (!state.stopped) {
        config.onError?.(error)
      }
      continue
    }
    const assignment = table?.assignments.get(partitionId)
    if (state.stopped || assignment === undefined) {
      return
    }
    if (assignment.primary !== nodeId || assignment.state !== 'INITIALISING') {
      return
    }
    if (state.activeBootstraps.has(partitionKey(indexName, partitionId))) {
      return
    }
    startBootstrap(state, config, indexName, partitionId, nodeId, assignment.primaryTerm)
    return
  }
}
