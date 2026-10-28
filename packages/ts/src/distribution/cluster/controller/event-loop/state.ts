import type { NodeEvent, NodeRegistration } from '../../../coordinator/types'
import type { NodeTransport } from '../../../transport/types'
import { DEFAULT_CONTROLLER_CONFIG } from '../../constants'

export interface EventLoopState {
  unwatchNodes: (() => void) | null
  placementByNodeId: Map<string, string>
  unwatchSchemas: (() => void) | null
  unwatchTransport: (() => void) | null
  knownIndexes: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  teardownTimers: Map<string, ReturnType<typeof setTimeout>>
  insyncQueue: Promise<void>
  transport: NodeTransport | null
  controllerNodeId: string | null
  nodeLeftDelayMs: number
  departedAt: Map<string, number>
  departureTimer: ReturnType<typeof setTimeout> | null
  rebalanceDrivers: Map<string, string>
  rebalanceEpoch: number
}

/**
 * Builds the state an active controller's event loop keeps, which starts with no watcher registered and no timer
 * pending.
 *
 * @param initialIndexNames - The indexes the controller starts with, which it allocates on its first run.
 * @param nodeLeftDelayMs - How long the controller waits after a node leaves before it moves that node's replicas.
 * @returns The fresh state, ready for {@link startEventLoop}.
 */
export function createEventLoopState(
  initialIndexNames: string[],
  nodeLeftDelayMs: number = DEFAULT_CONTROLLER_CONFIG.nodeLeftDelayMs,
): EventLoopState {
  return {
    nodeLeftDelayMs,
    departedAt: new Map(),
    departureTimer: null,
    unwatchNodes: null,
    placementByNodeId: new Map(),
    unwatchSchemas: null,
    unwatchTransport: null,
    knownIndexes: new Set(initialIndexNames),
    debounceTimer: null,
    teardownTimers: new Map(),
    insyncQueue: Promise.resolve(),
    transport: null,
    controllerNodeId: null,
    rebalanceDrivers: new Map(),
    rebalanceEpoch: 0,
  }
}

/**
 * Drops every watcher and timer the event loop registered, so that a controller which stood down leaves no work
 * running.
 *
 * The state stays usable afterwards, because a node that regains the controller lease starts its event loop again
 * over the same state.
 *
 * @param state - The event loop state to clear.
 */
export function clearEventLoopWatchers(state: EventLoopState): void {
  if (state.unwatchNodes !== null) {
    state.unwatchNodes()
    state.unwatchNodes = null
  }
  state.placementByNodeId.clear()
  if (state.unwatchSchemas !== null) {
    state.unwatchSchemas()
    state.unwatchSchemas = null
  }
  if (state.unwatchTransport !== null) {
    state.unwatchTransport()
    state.unwatchTransport = null
  }
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  for (const timer of state.teardownTimers.values()) {
    clearTimeout(timer)
  }
  state.teardownTimers.clear()
  if (state.departureTimer !== null) {
    clearTimeout(state.departureTimer)
    state.departureTimer = null
  }
  state.departedAt.clear()
  state.rebalanceDrivers.clear()
  state.rebalanceEpoch += 1
}

function placementOf(registration: NodeRegistration): string {
  const { memory: _memory, partitionBytes: _partitionBytes, ...placement } = registration
  return JSON.stringify(placement)
}

export function changesTopology(state: EventLoopState, event: NodeEvent): boolean {
  if (event.type === 'node_left' || event.registration === null) {
    state.placementByNodeId.delete(event.nodeId)
    state.departedAt.set(event.nodeId, Date.now())
    return true
  }
  state.departedAt.delete(event.nodeId)
  const placement = placementOf(event.registration)
  if (state.placementByNodeId.get(event.nodeId) === placement) {
    return false
  }
  state.placementByNodeId.set(event.nodeId, placement)
  return true
}
