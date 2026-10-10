import { createContext, createElement, type ReactElement, type ReactNode, useContext, useEffect, useState } from 'react'
import type { NarsilClient } from '../client'
import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../types/engine'
import type { NarsilEventMap } from '../types/events'
import { engineReader, type NarsilReader } from './reader'
import { createResourceStore, type ResourceStore } from './store'

export interface NarsilContextValue {
  reader: NarsilReader
  client: NarsilClient | null
  engine: Narsil | null
  store: ResourceStore
  keepAliveMs: number | undefined
  refreshAfterWriteMs: number | undefined
}

const NarsilContext = createContext<NarsilContextValue | null>(null)

/**
 * These settings apply to {@link NarsilProvider} whether it holds a client or
 * an engine.
 *
 * @public
 */
export interface NarsilProviderSettings {
  /** The provider keeps each answer for this many milliseconds after the last
   * component that reads the answer unmounts, which is 2000 unless you set
   * another value. That wait spans the gap between React unmounting a component
   * and mounting it again, so a quick navigation back can show the earlier
   * answer without sending a second request. */
  keepAliveMs?: number
  /** Under an engine, the hooks that read a written index search again once
   * this many milliseconds pass without another write to that index, so each
   * mounted hook searches once for a whole burst of writes. `useIndexes`
   * searches again once that many milliseconds pass without a write to any
   * index. The wait lasts 200 milliseconds unless you set another value. Under
   * a client, the setting has no effect,
   * because a server sends the client no write events. */
  refreshAfterWriteMs?: number
  /** React renders these components under the provider. */
  children?: ReactNode
}

/**
 * These props give {@link NarsilProvider} a client, so that every hook under
 * the provider sends its requests to a server.
 *
 * @public
 */
export interface NarsilClientProviderProps extends NarsilProviderSettings {
  /** Every hook under the provider sends its requests through this client.
   * Build the client once, outside the component tree, because a render that
   * builds a client builds a new one each time, so every hook under the
   * provider starts again. */
  client: NarsilClient
  /** Leave this unset, because a provider holds either a client or an engine. */
  engine?: undefined
}

/**
 * These props give {@link NarsilProvider} an engine in the same page, so that
 * every read hook under the provider calls that engine and searches again after
 * each burst of writes to an index that the hook reads.
 *
 * @public
 */
export interface NarsilEngineProviderProps extends NarsilProviderSettings {
  /** Every read hook under the provider calls this engine. Create the engine
   * once, outside the component tree, because a render that creates an engine
   * creates a new one each time, so every hook under the provider starts
   * again. */
  engine: Narsil
  /** Leave this unset, because a provider holds either a client or an engine. */
  client?: undefined
}

/**
 * These are the props of {@link NarsilProvider}, which hold either a client of
 * a server or an engine in the same page, together with the settings that both
 * cases share.
 *
 * @public
 */
export type NarsilProviderProps = NarsilClientProviderProps | NarsilEngineProviderProps

function buildContextValue(props: NarsilProviderProps): NarsilContextValue {
  const { client, engine, keepAliveMs, refreshAfterWriteMs } = props
  const shared = { store: createResourceStore(keepAliveMs, refreshAfterWriteMs), keepAliveMs, refreshAfterWriteMs }
  if (client !== undefined && engine === undefined) return { ...shared, reader: client, client, engine: null }
  if (engine !== undefined && client === undefined) {
    return { ...shared, reader: engineReader(engine), client: null, engine }
  }
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'A NarsilProvider requires exactly one of client and engine, but its props set both or neither',
  )
}

function providerPropsChanged(value: NarsilContextValue, props: NarsilProviderProps): boolean {
  return (
    value.client !== (props.client ?? null) ||
    value.engine !== (props.engine ?? null) ||
    value.keepAliveMs !== props.keepAliveMs ||
    value.refreshAfterWriteMs !== props.refreshAfterWriteMs
  )
}

function useStoreRetention(store: ResourceStore): void {
  useEffect(() => store.retain(), [store])
}

function useRefreshAfterWrites(engine: Narsil | null, store: ResourceStore): void {
  useEffect(() => {
    if (engine === null) return
    const onWrite = (payload: NarsilEventMap['write']): void => {
      store.invalidate(payload.indexName)
    }
    engine.on('write', onWrite)
    return () => {
      engine.off('write', onWrite)
    }
  }, [engine, store])
}

/**
 * This component gives every hook under it the client or the engine to call,
 * together with one store of answers that those hooks share.
 *
 * Every read hook calls the method of the same name on the client or on the
 * engine. When two components under one provider ask for the same thing, they
 * send one request and receive one answer. Under an engine, the provider
 * registers a listener for the engine's `write` event, so every mounted hook
 * that reads the written index searches again once per burst of writes. Once
 * the provider unmounts and `keepAliveMs` passes, the provider drops the shared
 * answers and stops waiting for the requests that are still in flight.
 *
 * @param props - These props set the client or the engine, the settings, and
 * the components that render under the provider.
 * @returns The element renders the children unchanged.
 * @throws A `NarsilError` with `CONFIG_INVALID` during the render, when the
 * props set both a client and an engine, or neither.
 *
 * @public
 */
export function NarsilProvider(props: NarsilProviderProps): ReactElement {
  const [value, setValue] = useState<NarsilContextValue>(() => buildContextValue(props))
  if (providerPropsChanged(value, props)) {
    setValue(buildContextValue(props))
  }

  useStoreRetention(value.store)
  useRefreshAfterWrites(value.engine, value.store)

  return createElement(NarsilContext.Provider, { value }, props.children)
}

/** Reads the context a hook runs in, and refuses to run without one. */
export function useNarsilContext(): NarsilContextValue {
  const value = useContext(NarsilContext)
  if (value === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A Narsil hook was called outside a NarsilProvider, so no client or engine is available to it',
    )
  }
  return value
}

export function useServerClient(hookName: string): NarsilClient {
  const { client } = useNarsilContext()
  if (client !== null) return client
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `${hookName} works only under a client of a server, because only a server handles tasks and imports, while the NarsilProvider above it holds an engine`,
    { hook: hookName },
  )
}

/**
 * This hook returns the client that the nearest {@link NarsilProvider} holds,
 * which serves every call that has no hook of its own, such as a write.
 *
 * @returns This is the client that the provider holds.
 * @throws A `NarsilError` with `CONFIG_INVALID` when no provider wraps the
 * component, and also when the provider holds an engine, which the component
 * can import directly.
 *
 * @public
 */
export function useNarsilClient(): NarsilClient {
  const { client } = useNarsilContext()
  if (client !== null) return client
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'useNarsilClient returns a client, while the NarsilProvider above it holds an engine, so import that engine directly',
    { hook: 'useNarsilClient' },
  )
}
