import type { NarsilError } from '../errors'
import { asNarsilError } from './failure'

/** The store keeps an answer for this long after the last component reading it
 * has gone. The wait covers the gap between React unmounting a component and
 * mounting it again, which a development double render and a quick navigation
 * both leave. */
export const DEFAULT_KEEP_ALIVE_MS = 2000

/**
 * Where one key stands: the answer, the failure, and the two loading flags.
 *
 * `isLoading` stays true until the first answer arrives, whether that answer is
 * a value or a failure, while `isFetching` marks a request in flight, including
 * every later one.
 */
export interface ResourceSnapshot<T> {
  /** This is the answer, and it stays undefined until the first one arrives. */
  readonly data: T | undefined
  /** This is the failure the last request ended on, and success clears it. */
  readonly error: NarsilError | undefined
  /** This is true until the first answer arrives. */
  readonly isLoading: boolean
  /** This is true while a request is in flight. */
  readonly isFetching: boolean
}

/** Sends the one request behind a key, and stops when the signal aborts. */
export type ResourceLoader = (signal: AbortSignal) => Promise<unknown>

/** What a hook reads before it subscribes, and again on the server, where no
 * request runs. */
export const LOADING_SNAPSHOT: ResourceSnapshot<never> = Object.freeze({
  data: undefined,
  error: undefined,
  isLoading: true,
  isFetching: true,
})

/** What a hook reads while it is switched off. */
export const IDLE_SNAPSHOT: ResourceSnapshot<never> = Object.freeze({
  data: undefined,
  error: undefined,
  isLoading: false,
  isFetching: false,
})

interface Entry {
  snapshot: ResourceSnapshot<unknown>
  listeners: Set<() => void>
  loader: ResourceLoader
  controller: AbortController | null
  version: number
  disposal: ReturnType<typeof setTimeout> | null
}

/**
 * Holds the answer behind each key for as long as a component reads it.
 *
 * One key holds one request, so several components asking the same thing share
 * it. The store drops a key once no component reads it and the keep-alive has
 * passed, and it stops whatever that key still had in flight.
 */
export interface ResourceStore {
  /**
   * Reads a key, and starts its request where nothing has answered yet.
   *
   * @param key - This identifies the request.
   * @param loader - This sends the request. The store holds the newest one it
   * was given, and any of them computes the same request, because the key
   * carries every argument.
   * @param onChange - The store calls this whenever the answer moves.
   * @returns Calling this drops the subscription.
   */
  subscribe(key: string, loader: ResourceLoader, onChange: () => void): () => void
  /**
   * Reads where a key stands right now.
   *
   * @param key - This identifies the request.
   * @returns The same object comes back until the answer moves, which is what
   * `useSyncExternalStore` needs.
   */
  snapshot(key: string): ResourceSnapshot<unknown>
  /**
   * Sends the request behind a key again, keeping the answer already shown
   * until the new one arrives. A request already in flight makes this a no-op.
   *
   * @param key - This identifies the request.
   */
  refresh(key: string): void
  /**
   * Marks the store as in use by one provider.
   *
   * @returns Calling this releases the provider's hold. The store clears
   * itself once the last hold has gone and the keep-alive has passed, so a
   * provider that unmounts and mounts again at once, which is what a
   * development double render does, keeps everything it held.
   */
  retain(): () => void
  /** Stops every request in flight and forgets every answer. */
  dispose(): void
}

/**
 * Builds the store one {@link NarsilProvider} shares among the hooks under it.
 *
 * @param keepAliveMs - The store keeps an answer for this many milliseconds
 * after the last component reading it has gone, and 2000 unless you say
 * otherwise.
 * @returns The store is empty, and it fills as components subscribe.
 */
export function createResourceStore(keepAliveMs = DEFAULT_KEEP_ALIVE_MS): ResourceStore {
  const entries = new Map<string, Entry>()
  let holders = 0
  let closing: ReturnType<typeof setTimeout> | null = null

  function publish(entry: Entry, next: ResourceSnapshot<unknown>): void {
    entry.snapshot = next
    for (const listener of entry.listeners) listener()
  }

  function load(key: string, entry: Entry): void {
    if (entry.controller !== null) return
    const controller = new AbortController()
    entry.controller = controller
    entry.version++
    const version = entry.version
    if (!entry.snapshot.isFetching) publish(entry, { ...entry.snapshot, isFetching: true })

    const current = (): boolean => entries.get(key) === entry && entry.version === version
    entry.loader(controller.signal).then(
      data => {
        if (!current()) return
        entry.controller = null
        publish(entry, { data, error: undefined, isLoading: false, isFetching: false })
      },
      (err: unknown) => {
        if (!current()) return
        entry.controller = null
        if (controller.signal.aborted) return
        publish(entry, {
          data: entry.snapshot.data,
          error: asNarsilError(err, 'A Narsil hook'),
          isLoading: false,
          isFetching: false,
        })
      },
    )
  }

  function disposeAll(): void {
    for (const [key, entry] of [...entries]) drop(key, entry)
    entries.clear()
  }

  function drop(key: string, entry: Entry): void {
    if (entries.get(key) === entry) entries.delete(key)
    if (entry.disposal !== null) clearTimeout(entry.disposal)
    entry.disposal = null
    entry.controller?.abort()
    entry.controller = null
  }

  return {
    subscribe(key, loader, onChange) {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = {
          snapshot: LOADING_SNAPSHOT,
          listeners: new Set(),
          loader,
          controller: null,
          version: 0,
          disposal: null,
        }
        entries.set(key, entry)
      } else {
        entry.loader = loader
        if (entry.disposal !== null) {
          clearTimeout(entry.disposal)
          entry.disposal = null
        }
      }

      const held = entry
      held.listeners.add(onChange)
      const retryable = held.snapshot.isLoading || held.snapshot.error !== undefined
      if (retryable && held.controller === null) load(key, held)

      return () => {
        held.listeners.delete(onChange)
        if (held.listeners.size > 0 || entries.get(key) !== held || held.disposal !== null) return
        held.disposal = setTimeout(() => {
          held.disposal = null
          if (held.listeners.size === 0) drop(key, held)
        }, keepAliveMs)
      }
    },
    snapshot(key) {
      return entries.get(key)?.snapshot ?? LOADING_SNAPSHOT
    },
    refresh(key) {
      const entry = entries.get(key)
      if (entry !== undefined) load(key, entry)
    },
    retain() {
      holders++
      if (closing !== null) {
        clearTimeout(closing)
        closing = null
      }
      let released = false
      return () => {
        if (released) return
        released = true
        holders--
        if (holders > 0) return
        closing = setTimeout(() => {
          closing = null
          if (holders === 0) disposeAll()
        }, keepAliveMs)
      }
    },
    dispose: disposeAll,
  }
}
