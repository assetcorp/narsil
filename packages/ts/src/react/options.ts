import type { RequestOptions } from '../client'
import type { NarsilError } from '../errors'

/**
 * A hook sends these settings with each request that it makes through a
 * client.
 *
 * A hook owns the lifetime of its own request, so these settings include no
 * signal. The provider stops waiting for a request once `keepAliveMs` passes
 * with no component reading its answer. Under an engine, the hooks leave both
 * settings out, because the engine answers in the same page.
 *
 * @public
 */
export interface NarsilRequestSettings {
  /** Under a client, the hook sends these headers with its request. */
  headers?: Record<string, string>
  /** Under a client, the hook gives the server this many milliseconds to
   * answer, and 0 sets no deadline. */
  timeoutMs?: number
}

/**
 * These settings change what a read hook does, and they form the last argument
 * of every read hook.
 *
 * @public
 */
export interface NarsilReadOptions extends NarsilRequestSettings {
  /** The hook sends nothing while this is false, and it reports no data and no
   * failure, so keep it false until a search has a term. */
  enabled?: boolean
  /** The hook keeps showing the last answer while the next one loads, which
   * keeps a result list in place as somebody types. */
  keepPreviousData?: boolean
  /** The hook sends the request again at this interval, in milliseconds,
   * pausing while the page is hidden. Without this setting, the hook sends
   * the request once, and again under an engine after a write. */
  refreshIntervalMs?: number
}

/**
 * What a read hook reports.
 *
 * `isLoading` covers the wait for the first answer, so show a spinner while it
 * is true. `isFetching` covers every request including a refresh, so show a
 * quieter indicator while that one is true.
 *
 * @typeParam T - This is what the method behind the hook returns.
 *
 * @public
 */
export interface NarsilReadState<T> {
  /** This is the answer, and it stays undefined until the first one arrives. */
  data: T | undefined
  /** This is the failure that the last request ended on, and the next success
   * clears it. */
  error: NarsilError | undefined
  /** This is true while the hook waits for an answer and has none to show. */
  isLoading: boolean
  /** This is true while a request is in flight, including a refresh. */
  isFetching: boolean
  /** Calling this sends the request again, and the answer already on screen
   * stays there until the new one arrives. */
  refresh: () => void
}

export function requestOf(settings: NarsilRequestSettings | undefined): RequestOptions {
  return { headers: settings?.headers, timeoutMs: settings?.timeoutMs }
}
