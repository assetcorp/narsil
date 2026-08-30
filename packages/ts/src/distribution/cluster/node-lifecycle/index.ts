import { ErrorCodes, NarsilError } from '../../../errors'
import { type AllocationWatcherState, createAllocationWatcherState, stopAllocationWatcher } from './allocation-watcher'
import {
  createRegistrationHeartbeatState,
  type RegistrationHeartbeatState,
  stopRegistrationHeartbeat,
} from './heartbeat'
import { joinCluster, leaveCluster } from './join'
import type { DataNodeHandle, DataNodeLifecycleStatus, NodeLifecycleConfig } from './types'

/**
 * Builds the handle a data node joins the cluster with, leaves it with, and shuts down through.
 *
 * The handle reports its own status, and it runs one lifecycle operation at a time, so a `leave` called while a
 * `join` is still running waits for that join rather than interleaving with it. A node that has shut down cannot
 * rejoin through the same handle.
 *
 * @param config - The lifecycle configuration, which names the coordinator, the transport, this node's
 *   registration, and the retry limits every bootstrap follows.
 * @returns The handle, whose status starts as `stopped`.
 */
export function createDataNodeLifecycle(config: NodeLifecycleConfig): DataNodeHandle {
  let status: DataNodeLifecycleStatus = 'stopped'
  let registered = false
  let watcherState: AllocationWatcherState = createAllocationWatcherState()
  const heartbeatState: RegistrationHeartbeatState = createRegistrationHeartbeatState()
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

    get registered(): boolean {
      return registered
    },

    get pendingPartitionCount(): number {
      return watcherState.pendingPartitions.size
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
          await joinCluster(
            {
              ...config,
              onRegistered: () => {
                registered = true
                config.onRegistered?.()
              },
            },
            watcherState,
            heartbeatState,
          )
          status = 'active'
        } catch (error) {
          await stopRegistrationHeartbeat(heartbeatState)
          registered = false
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
        await stopRegistrationHeartbeat(heartbeatState)
        stopAllocationWatcher(watcherState)

        try {
          await leaveCluster(config)
        } finally {
          registered = false
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

        await stopRegistrationHeartbeat(heartbeatState)
        stopAllocationWatcher(watcherState)

        if (status === 'active' || status === 'joining') {
          try {
            await leaveCluster(config)
          } catch (_) {
            /* Deregister failure during shutdown is non-critical */
          }
        }

        registered = false
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
