import { createContext, createElement, type ReactElement, type ReactNode, useContext, useEffect, useState } from 'react'
import type { NarsilClient } from '../client'
import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../types/engine'
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
 * These settings apply to {@link NarsilProvider} under a client and under an
 * engine alike.
 *
 * @public
 */
export interface NarsilProviderSettings {
  /** The provider keeps an answer for this many milliseconds after the last
   * component that reads it unmounts. The default is 2000. The wait covers the
   * gap between React unmounting a component and mounting it again, so after a
   * quick navigation back, the hook shows the earlier answer and sends no second
   * request. */
  keepAliveMs?: number
  /** Under an engine, the provider starts a refresh once this many milliseconds
   * pass with no further write. The default is 200. A burst of writes
   * therefore produces one refresh, and the refresh includes every write in the
   * burst. A client of a server reports no writes, so the setting changes
   * nothing under a client. */
  refreshAfterWriteMs?: number
  /** These are the components that the provider covers. */
  children?: ReactNode
}

/**
 * These props give {@link NarsilProvider} a client, so that every hook under
 * it reads from a server.
 *
 * @public
 */
export interface NarsilClientProviderProps extends NarsilProviderSettings {
  /** Every hook under the provider sends its request through this client.
   * Build the client once, outside the component tree, because a render that
   * builds a client builds a new one each time, so the provider drops every
   * answer that the hooks under it share. */
  client: NarsilClient
  /** Leave this out, because a provider holds a client or an engine, never
   * both. */
  engine?: undefined
}

/**
 * These props give {@link NarsilProvider} an engine, so that every read hook
 * under it searches that engine in the same page and searches again after each
 * burst of writes to it.
 *
 * @public
 */
export interface NarsilEngineProviderProps extends NarsilProviderSettings {
  /** Every read hook under the provider calls this engine. Create the engine
   * once, outside the component tree, because a render that creates an engine
   * creates a new one each time, with none of the indexes that the first one
   * holds. */
  engine: Narsil
  /** Leave this out, because a provider holds a client or an engine, never
   * both. */
  client?: undefined
}

/**
 * These are the props of {@link NarsilProvider}: a client of a server or an
 * engine in the same page, together with the settings that both share.
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
    'A NarsilProvider requires exactly one of client and engine, and its props set both or neither',
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

/**
 * Gives every hook below it a source to read from, and the state that those
 * hooks share.
 *
 * The source is a client of a server or an engine in the same page, and every
 * read hook calls the method of the same name on that source. Two components
 * that ask for the same thing under one provider send one request and read one
 * answer. Under an engine, the provider listens for the engine's `write` event,
 * so every mounted hook that reads the written index searches again once per
 * burst of writes. Once the provider unmounts, it drops the shared state and
 * stops waiting for every request still in flight.
 *
 * @param props - These name the client or the engine, and the components that
 * the provider covers.
 * @returns The provider renders its children unchanged.
 * @throws A `NarsilError` with `CONFIG_INVALID` as it renders, when its props
 * set both a client and an engine, or neither.
 *
 * @public
 */
export function NarsilProvider(props: NarsilProviderProps): ReactElement {
  const [value, setValue] = useState<NarsilContextValue>(() => buildContextValue(props))
  if (providerPropsChanged(value, props)) {
    setValue(buildContextValue(props))
  }

  useEffect(() => {
    const release = value.store.retain()
    const engine = value.engine
    if (engine === null) return release
    const onWrite = (payload: { indexName: string }): void => {
      value.store.invalidate(payload.indexName)
    }
    engine.on('write', onWrite)
    return () => {
      engine.off('write', onWrite)
      release()
    }
  }, [value])

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
  return requireClient(
    useNarsilContext(),
    hookName,
    `${hookName} works only under a client of a server, because only a server handles tasks and imports, while the NarsilProvider above it holds an engine`,
  )
}

function requireClient(value: NarsilContextValue, hookName: string, refusal: string): NarsilClient {
  if (value.client !== null) return value.client
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, refusal, { hook: hookName })
}

/**
 * Returns the client that the nearest {@link NarsilProvider} holds, for every
 * call that has no hook of its own.
 *
 * @returns This is the client that the provider holds.
 * @throws A `NarsilError` with `CONFIG_INVALID` when the component has no
 * provider above it, and when the provider holds an engine, which the
 * component can import directly.
 *
 * @public
 */
export function useNarsilClient(): NarsilClient {
  return requireClient(
    useNarsilContext(),
    'useNarsilClient',
    'useNarsilClient returns a client, while the NarsilProvider above it holds an engine, so import that engine directly',
  )
}
