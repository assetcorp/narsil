import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RequestOptions } from '../client'
import { useNarsilContext } from './context'
import { hashKey } from './key'
import { type NarsilReadOptions, type NarsilReadState, requestOf } from './options'
import { usePolling } from './poll'
import type { NarsilReader } from './reader'
import { IDLE_SNAPSHOT, LOADING_SNAPSHOT, type ResourceSnapshot, type WriteScope } from './store'

const NO_SUBSCRIPTION = (): void => {}

export type ReadRunner<S, T> = (source: S, request: RequestOptions) => Promise<T>

interface LatestCall<S, T> {
  run: ReadRunner<S, T>
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

export function useRead<S, T>(
  source: S,
  parts: readonly unknown[],
  run: ReadRunner<S, T>,
  options: NarsilReadOptions | undefined,
  writeScope: WriteScope,
): NarsilReadState<T> {
  const { store } = useNarsilContext()
  const enabled = options?.enabled ?? true
  const headers = options?.headers
  const timeoutMs = options?.timeoutMs
  const key = useKey([...parts, headers, timeoutMs])

  const call = useRef<LatestCall<S, T>>({ run, request: requestOf(options) })
  useEffect(() => {
    call.current = { run, request: requestOf(options) }
  })

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled) return NO_SUBSCRIPTION
      const loader = (signal: AbortSignal): Promise<T> => {
        const held = call.current
        return held.run(source, { ...held.request, signal })
      }
      return store.subscribe(key, loader, onChange, writeScope)
    },
    [enabled, store, source, key, writeScope],
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

export function useProviderRead<T>(
  parts: readonly unknown[],
  run: ReadRunner<NarsilReader, T>,
  options: NarsilReadOptions | undefined,
  writeScope: WriteScope,
): NarsilReadState<T> {
  const { reader } = useNarsilContext()
  return useRead(reader, parts, run, options, writeScope)
}
