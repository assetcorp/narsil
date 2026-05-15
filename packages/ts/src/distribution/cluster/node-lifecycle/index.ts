import { ErrorCodes, NarsilError } from '../../../errors'
import { type AllocationWatcherState, createAllocationWatcherState, stopAllocationWatcher } from './allocation-watcher'
import { joinCluster, leaveCluster } from './join'
import type { DataNodeHandle, DataNodeLifecycleStatus, NodeLifecycleConfig } from './types'

export function createDataNodeLifecycle(config: NodeLifecycleConfig): DataNodeHandle {
  let status: DataNodeLifecycleStatus = 'stopped'
  let watcherState: AllocationWatcherState = createAllocationWatcherState()
  let operationLock: Promise<void> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = operationLock
    let releaseLock: (() => void) | undefined
    operationLock = new Promise<void>(r => {
      releaseLock = r
    })
    return prev.then(async () => {
      try {
        return await fn()
      } finally {
        if (releaseLock !== undefined) {
          releaseLock()
        }
      }
    })
  }

  const handle: DataNodeHandle = {
    get status(): DataNodeLifecycleStatus {
      return status
    },

    get nodeId(): string {
      return config.registration.nodeId
    },

    join(): Promise<void> {
      return withLock(async () => {
        if (status === 'active' || status === 'joining') {
          throw new NarsilError(
            ErrorCodes.NODE_ALREADY_JOINED,
            `Node '${config.registration.nodeId}' has already joined the cluster`,
            { nodeId: config.registration.nodeId, currentStatus: status },
          )
        }

        if (status === 'shutdown') {
          throw new NarsilError(
            ErrorCodes.NODE_NOT_JOINED,
            `Node '${config.registration.nodeId}' has been shut down and cannot rejoin`,
            { nodeId: config.registration.nodeId },
          )
        }

        status = 'joining'

        try {
          await joinCluster(config, watcherState)
          status = 'active'
        } catch (error) {
          status = 'stopped'
          throw error
        }
      })
    },

    leave(): Promise<void> {
      return withLock(async () => {
        if (status !== 'active') {
          return
        }

        status = 'leaving'
        stopAllocationWatcher(watcherState)

        try {
          await leaveCluster(config)
        } finally {
          status = 'stopped'
          watcherState = createAllocationWatcherState()
        }
      })
    },

    shutdown(): Promise<void> {
      return withLock(async () => {
        if (status === 'shutdown') {
          return
        }

        stopAllocationWatcher(watcherState)

        if (status === 'active' || status === 'joining') {
          try {
            await leaveCluster(config)
          } catch (_) {
            /* Deregister failure during shutdown is non-critical */
          }
        }

        status = 'shutdown'
        watcherState = createAllocationWatcherState()
      })
    },
  }

  return handle
}

export { reportBootstrapComplete } from './bootstrap'
export type { DataNodeHandle, DataNodeLifecycleStatus, NodeLifecycleConfig, PartitionBootstrapState } from './types'
export { DEFAULT_NODE_LIFECYCLE_CONFIG } from './types'
