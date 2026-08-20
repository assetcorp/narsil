export interface EventLoopState {
  unwatchNodes: (() => void) | null
  unwatchSchemas: (() => void) | null
  unwatchTransport: (() => void) | null
  knownIndexes: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  insyncQueue: Promise<void>
}

export function createEventLoopState(initialIndexNames: string[]): EventLoopState {
  return {
    unwatchNodes: null,
    unwatchSchemas: null,
    unwatchTransport: null,
    knownIndexes: new Set(initialIndexNames),
    debounceTimer: null,
    insyncQueue: Promise.resolve(),
  }
}

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
}
