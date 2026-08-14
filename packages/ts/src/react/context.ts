import { createContext, createElement, type ReactElement, type ReactNode, useContext, useEffect, useMemo } from 'react'
import type { NarsilClient } from '../client'
import { ErrorCodes, NarsilError } from '../errors'
import { createResourceStore, type ResourceStore } from './store'

export interface NarsilContextValue {
  client: NarsilClient
  store: ResourceStore
}

const NarsilContext = createContext<NarsilContextValue | null>(null)

/**
 * These are the settings {@link NarsilProvider} takes.
 *
 * @public
 */
export interface NarsilProviderProps {
  /** Every hook under the provider sends through this client. Build it once,
   * outside the component tree, because a client built during a render would
   * throw away everything the hooks under it hold. */
  client: NarsilClient
  /** The hooks keep an answer for this many milliseconds after the last
   * component reading it has gone, and 2000 unless you say otherwise. The wait
   * covers the gap between React unmounting a component and mounting it again,
   * so a quick navigation back shows what it showed before and sends no second
   * request. */
  keepAliveMs?: number
  /** These are the components the provider covers. */
  children?: ReactNode
}

/**
 * Gives every hook below it the client to send through, and the shared state
 * they read.
 *
 * Two components asking for the same thing under one provider send one request
 * and read one answer. The provider drops that state when it unmounts, and it
 * stops whatever is still in flight.
 *
 * @param props - These name the client and the components the provider covers.
 * @returns The provider renders its children unchanged.
 *
 * @public
 */
export function NarsilProvider(props: NarsilProviderProps): ReactElement {
  const { client, keepAliveMs, children } = props
  const value = useMemo<NarsilContextValue>(
    () => ({ client, store: createResourceStore(keepAliveMs) }),
    [client, keepAliveMs],
  )
  useEffect(() => value.store.retain(), [value])
  return createElement(NarsilContext.Provider, { value }, children)
}

export function useNarsilContext(): NarsilContextValue {
  const value = useContext(NarsilContext)
  if (value === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'A Narsil hook ran outside a NarsilProvider, so it found no client to send through',
    )
  }
  return value
}

/**
 * Reads the client the nearest {@link NarsilProvider} holds, which is what any
 * call the hooks leave out goes through.
 *
 * @returns This is the client the provider was given.
 * @throws A `NarsilError` with `CONFIG_INVALID` when no provider stands above
 * the component.
 *
 * @public
 */
export function useNarsilClient(): NarsilClient {
  return useNarsilContext().client
}
