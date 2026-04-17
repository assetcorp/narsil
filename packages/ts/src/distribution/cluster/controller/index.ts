import {
  clearElectionTimers,
  createElectionState,
  type ElectionState,
  releaseLease,
  scheduleStandbyRetry,
  startRenewalInterval,
  tryAcquireLease,
} from './election'
import { clearEventLoopWatchers, createEventLoopState, type EventLoopState, startEventLoop } from './event-loop'
import type { ControllerConfig, ControllerNode } from './types'

export function createController(config: ControllerConfig): ControllerNode {
  const { nodeId, coordinator, transport, leaseTtlMs, standbyRetryMs, knownIndexNames, onError } = config

  let electionState: ElectionState = createElectionState()
  let eventLoopState: EventLoopState = createEventLoopState(knownIndexNames)
  let stopped = false

  function isActive(): boolean {
    return electionState.active
  }

  function stepDown(): void {
    if (!electionState.active) {
      return
    }
    electionState.active = false
    clearElectionTimers(electionState)
    clearEventLoopWatchers(eventLoopState)

    if (!stopped) {
      scheduleStandbyRetry(electionState, standbyRetryMs, () => {
        tryElection().catch(() => {
          /* Election retry failure; next standby timer will retry */
        })
      })
    }
  }

  async function becomeActive(): Promise<void> {
    if (electionState.active) {
      return
    }
    electionState.active = true

    startRenewalInterval(electionState, coordinator, nodeId, leaseTtlMs, stepDown)

    await startEventLoop(eventLoopState, coordinator, transport, nodeId, isActive, onError)
  }

  async function tryElection(): Promise<void> {
    if (stopped) {
      return
    }

    const acquired = await tryAcquireLease(coordinator, nodeId, leaseTtlMs)

    if (acquired) {
      await becomeActive()
    } else {
      scheduleStandbyRetry(electionState, standbyRetryMs, () => {
        tryElection().catch(() => {
          /* Election retry failure; next standby timer will retry */
        })
      })
    }
  }

  const controller: ControllerNode = {
    get isActive(): boolean {
      return electionState.active
    },

    async start(): Promise<void> {
      stopped = false
      await tryElection()
    },

    async stop(): Promise<void> {
      stopped = true
      clearElectionTimers(electionState)
      clearEventLoopWatchers(eventLoopState)

      if (electionState.active) {
        electionState.active = false
        try {
          await releaseLease(coordinator)
        } catch (_) {
          /* Lease release failure during stop is non-critical */
        }
      }
    },

    async shutdown(): Promise<void> {
      await controller.stop()
      eventLoopState = createEventLoopState([])
      electionState = createElectionState()
    },
  }

  return controller
}

export type { IndexMetadata } from '../index-metadata'
export { getIndexMetadata, putIndexMetadata, validateIndexName } from '../index-metadata'
export type { ControllerConfig, ControllerNode } from './types'
export { CONTROLLER_LEASE_KEY, DEFAULT_CONTROLLER_CONFIG } from './types'
