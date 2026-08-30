import type { NodeTransport } from '../../../transport/types'

export interface EventLoopState {
  unwatchNodes: (() => void) | null
  unwatchSchemas: (() => void) | null
  unwatchTransport: (() => void) | null
  knownIndexes: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  teardownTimers: Map<string, ReturnType<typeof setTimeout>>
  insyncQueue: Promise<void>
  transport: NodeTransport | null
  controllerNodeId: string | null
}

/**
 * Builds the state an active controller's event loop keeps, which starts with no watcher registered and no timer
 * pending.
 *
 * @param initialIndexNames - The indexes the controller starts with, which it allocates on its first run.
 * @returns The fresh state, ready for {@link startEventLoop}.
 */
export function createEventLoopState(initialIndexNames: string[]): EventLoopState {
  return {
    unwatchNodes: null,
    unwatchSchemas: null,
    unwatchTransport: null,
    knownIndexes: new Set(initialIndexNames),
    debounceTimer: null,
    teardownTimers: new Map(),
    insyncQueue: Promise.resolve(),
    transport: null,
    controllerNodeId: null,
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
}
