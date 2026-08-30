import {
  clearElectionTimers,
  clearStandbyTimer,
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
  const { nodeId, coordinator, transport, leaseTtlMs, standbyRetryMs, knownIndexNames, onError, onElectionError } =
    config

  let electionState: ElectionState = createElectionState()
  let eventLoopState: EventLoopState = createEventLoopState(knownIndexNames)
  let stopped = false

  function isActive(): boolean {
    return electionState.active
  }

  function standBy(): void {
    if (stopped) {
      return
    }
    scheduleStandbyRetry(electionState, standbyRetryMs, () => {
      void runElection()
    })
  }

  function stepDown(): void {
    if (!electionState.active) {
      return
    }
    electionState.active = false
    clearElectionTimers(electionState)
    clearEventLoopWatchers(eventLoopState)
    standBy()
  }

  async function becomeActive(): Promise<void> {
    if (electionState.active) {
      return
    }
    electionState.active = true

    startRenewalInterval(electionState, coordinator, nodeId, leaseTtlMs, stepDown)

    try {
      for (const indexName of await coordinator.listSchemas()) {
        eventLoopState.knownIndexes.add(indexName)
      }
    } catch (_) {
      /* Listing failure is recoverable; schema events refill knownIndexes */
    }

    try {
      await startEventLoop(eventLoopState, coordinator, transport, nodeId, isActive, onError)
    } catch (error) {
      electionState.active = false
      clearElectionTimers(electionState)
      try {
        await releaseLease(coordinator)
      } catch (_) {
        /* Lease release failure while abandoning an incomplete start is non-critical */
      }
      throw error
    }
  }

  async function standForElection(): Promise<void> {
    if (stopped) {
      return
    }

    const acquired = await tryAcquireLease(coordinator, nodeId, leaseTtlMs)

    if (stopped) {
      if (acquired) {
        await releaseLease(coordinator)
      }
      return
    }

    if (acquired) {
      await becomeActive()
      return
    }

    standBy()
  }

  function reportElectionFailure(error: unknown): void {
    if (onElectionError === undefined) {
      return
    }
    try {
      onElectionError(error)
    } catch (_) {
      /* A reporting failure must never stop this node standing for election again */
    }
  }

  async function runElection(): Promise<void> {
    try {
      await standForElection()
    } catch (error) {
      reportElectionFailure(error)
      standBy()
    }
  }

  const controller: ControllerNode = {
    get isActive(): boolean {
      return electionState.active
    },

    async start(): Promise<void> {
      stopped = false
      clearStandbyTimer(electionState)
      try {
        await standForElection()
      } catch (error) {
        standBy()
        throw error
      }
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
