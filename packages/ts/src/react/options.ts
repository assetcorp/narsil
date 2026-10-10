import type { RequestOptions } from '../client'
import type { NarsilError } from '../errors'

/**
 * A hook sends these settings with each request that it makes through a
 * client.
 *
 * These settings include no signal, because each hook controls the lifetime of
 * its own request. The provider stops waiting for a request once `keepAliveMs`
 * passes with no component reading the answer. Under an engine, the hooks pass
 * neither setting to the engine, because the engine computes its results in the
 * same page.
 *
 * @public
 */
export interface NarsilRequestSettings {
  /** Under a client, the hook sends these headers with its request. */
  headers?: Record<string, string>
  /** Under a client, the hook gives the server this many milliseconds to
   * respond, while 0 sets no deadline. */
  timeoutMs?: number
}

/**
 * These settings, which form the last argument of every read hook, change what
 * the hook does.
 *
 * @public
 */
export interface NarsilReadOptions extends NarsilRequestSettings {
  /** While this is false, the hook sends no request and reports neither data
   * nor a failure, so keep it false until a search has a term. */
  enabled?: boolean
  /** The hook keeps showing the last answer while the next request is in
   * flight, which keeps a result list in place as somebody types. */
  keepPreviousData?: boolean
  /** The hook sends the request again at this interval in milliseconds,
   * pausing while the page is hidden. Without this setting, the hook sends the
   * request once, then again after each burst of writes when the provider holds
   * an engine. */
  refreshIntervalMs?: number
}

/**
 * These fields report where the request of a read hook stands.
 *
 * `isLoading` covers the wait for the first answer, so show a spinner while it
 * is true. `isFetching` covers every request, including a refresh, so show a
 * quieter indicator while that one is true.
 *
 * @typeParam T - This is the type that the method behind the hook returns.
 *
 * @public
 */
export interface NarsilReadState<T> {
  /** This is the answer, which stays undefined until the first request
   * succeeds. */
  data: T | undefined
  /** This is the failure that ended the last request, until the next success
   * clears it. */
  error: NarsilError | undefined
  /** This is true while the hook has no answer to show and a request is in
   * flight. */
  isLoading: boolean
  /** This is true while a request is in flight, including a refresh. */
  isFetching: boolean
  /** Calling this sends the request again, while the answer already on screen
   * stays until the new answer replaces it. */
  refresh: () => void
}

export function requestOf(settings: NarsilRequestSettings | undefined): RequestOptions {
  return { headers: settings?.headers, timeoutMs: settings?.timeoutMs }
}
