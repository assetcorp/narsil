import type { NarsilEventHandlers, NarsilEventMap } from '../types/events'

export type EngineEventHandlers = Map<string, Set<(payload: unknown) => void>>

export function eventHandlersOf(events: NarsilEventHandlers | undefined): EngineEventHandlers {
  const handlers: EngineEventHandlers = new Map()
  for (const [event, handler] of Object.entries(events ?? {})) {
    if (typeof handler === 'function') handlers.set(event, new Set([handler as (payload: unknown) => void]))
  }
  return handlers
}

export function emitEngineEvent<E extends keyof NarsilEventMap>(
  eventHandlers: EngineEventHandlers,
  event: E,
  payload: NarsilEventMap[E],
): number {
  const handlers = eventHandlers.get(event)
  if (!handlers || handlers.size === 0) return 0
  for (const handler of handlers) {
    try {
      handler(payload)
    } catch (err) {
      console.warn(`${event} handler error:`, err instanceof Error ? err.message : String(err))
    }
  }
  return handlers.size
}
