import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { NarsilClient, RequestOptions } from '../client'
import type { NarsilError } from '../errors'
import { useNarsilContext } from './context'
import { hashKey } from './key'
import { usePolling } from './poll'
import { IDLE_SNAPSHOT, LOADING_SNAPSHOT, type ResourceSnapshot } from './store'

const NO_SUBSCRIPTION = (): void => {}

/**
 * These settings change what a read hook does, and every read hook takes them
 * as its last argument.
 *
 * @public
 */
export interface NarsilReadOptions {
  /** The hook sends nothing while this is false, and it reports no data and no
   * failure, which is how a search waits for a term. */
  enabled?: boolean
  /** The hook keeps showing the last answer while the next one loads, which
   * holds a result list steady as somebody types. */
  keepPreviousData?: boolean
  /** The hook asks again this often, in milliseconds, and it pauses while the
   * page is hidden. It asks once and stops unless you set this. */
  refreshIntervalMs?: number
  /** The hook sends these headers with its request. */
  headers?: Record<string, string>
  /** The hook gives the server this many milliseconds to answer, and 0 waits
   * for as long as the server takes. */
  timeoutMs?: number
}

/**
 * What a read hook reports.
 *
 * `isLoading` covers the wait for the first answer, so a spinner reads it,
 * while `isFetching` covers every request including a refresh, so a quieter
 * indicator reads that one.
 *
 * @typeParam T - This is what the underlying client method answers with.
 *
 * @public
 */
export interface NarsilReadState<T> {
  /** This is the answer, and it stays undefined until the first one arrives. */
  data: T | undefined
  /** This is the failure the last request ended on, and the next success clears it. */
  error: NarsilError | undefined
  /** This is true while the hook waits for an answer and has none to show. */
  isLoading: boolean
  /** This is true while a request is in flight, including a refresh. */
  isFetching: boolean
  /** Calling this asks the server again, keeping the answer on screen until the
   * new one arrives. */
  refresh: () => void
}

export type ReadRunner<T> = (client: NarsilClient, request: RequestOptions) => Promise<T>

interface LatestCall<T> {
  run: ReadRunner<T>
  headers: Record<string, string> | undefined
  timeoutMs: number | undefined
}

function useKey(parts: readonly unknown[]): string {
  const cached = useRef<{ parts: readonly unknown[]; key: string } | null>(null)
  const held = cached.current
  if (
    held !== null &&
    held.parts.length === parts.length &&
    parts.every((part, at) => Object.is(part, held.parts[at]))
  ) {
    return held.key
  }
  const key = hashKey(parts)
  cached.current = { parts, key }
  return key
}

/**
 * Runs one client method under the shared state, which is what every read hook
 * is built on.
 *
 * @typeParam T - This is what the client method answers with.
 * @param parts - These identify the request: the method name and its arguments.
 * @param run - This sends the request. The hook holds the one it was given for
 * as long as the key stands, which is safe because the key carries every
 * argument the request reads.
 * @param options - These switch the hook off, keep the last answer, set a
 * refresh interval, and carry the headers and the deadline.
 * @returns The state holds the answer, the failure, the two loading flags, and
 * the way to ask again.
 */
export function useRead<T>(
  parts: readonly unknown[],
  run: ReadRunner<T>,
  options: NarsilReadOptions | undefined,
): NarsilReadState<T> {
  const { client, store } = useNarsilContext()
  const enabled = options?.enabled ?? true
  const headers = options?.headers
  const timeoutMs = options?.timeoutMs
  const key = useKey([...parts, headers, timeoutMs])

  const call = useRef<LatestCall<T>>({ run, headers, timeoutMs })
  useEffect(() => {
    call.current = { run, headers, timeoutMs }
  })

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled) return NO_SUBSCRIPTION
      const loader = (signal: AbortSignal): Promise<T> => {
        const held = call.current
        return held.run(client, { signal, headers: held.headers, timeoutMs: held.timeoutMs })
      }
      return store.subscribe(key, loader, onChange)
    },
    [enabled, store, client, key],
  )
  const readSnapshot = useCallback(
    () => (enabled ? store.snapshot(key) : IDLE_SNAPSHOT) as ResourceSnapshot<T>,
    [enabled, store, key],
  )
  const readServerSnapshot = useCallback(
    () => (enabled ? LOADING_SNAPSHOT : IDLE_SNAPSHOT) as ResourceSnapshot<T>,
    [enabled],
  )

  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot)

  const kept = useRef<T | undefined>(undefined)
  useEffect(() => {
    if (snapshot.data !== undefined) kept.current = snapshot.data
  }, [snapshot.data])

  const refresh = useCallback(() => {
    if (enabled) store.refresh(key)
  }, [enabled, store, key])

  usePolling(refresh, options?.refreshIntervalMs ?? 0, enabled)

  const keepPrevious = options?.keepPreviousData ?? false
  const data = snapshot.data === undefined && keepPrevious ? kept.current : snapshot.data

  return useMemo(
    () => ({
      data,
      error: snapshot.error,
      isLoading: snapshot.isLoading && data === undefined,
      isFetching: snapshot.isFetching,
      refresh,
    }),
    [data, snapshot, refresh],
  )
}
