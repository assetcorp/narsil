import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { NarsilClient, RequestOptions } from '../client'
import { useNarsilContext } from './context'
import { hashKey } from './key'
import { type NarsilReadOptions, type NarsilReadState, requestOf } from './options'
import { usePolling } from './poll'
import { IDLE_SNAPSHOT, LOADING_SNAPSHOT, type ResourceSnapshot } from './store'

const NO_SUBSCRIPTION = (): void => {}

/** Sends one client method's request, which is the part a read hook fills in. */
export type ReadRunner<T> = (client: NarsilClient, request: RequestOptions) => Promise<T>

interface LatestCall<T> {
  run: ReadRunner<T>
  request: RequestOptions
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

  const call = useRef<LatestCall<T>>({ run, request: requestOf(options) })
  useEffect(() => {
    call.current = { run, request: requestOf(options) }
  })

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled) return NO_SUBSCRIPTION
      const loader = (signal: AbortSignal): Promise<T> => {
        const held = call.current
        return held.run(client, { ...held.request, signal })
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

  const keepPrevious = (options?.keepPreviousData ?? false) && snapshot.isLoading
  const data = keepPrevious && snapshot.data === undefined ? kept.current : snapshot.data

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
