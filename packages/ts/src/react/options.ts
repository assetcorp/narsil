import type { RequestOptions } from '../client'
import type { NarsilError } from '../errors'

/**
 * What every hook sends with each request it makes.
 *
 * A hook owns the lifetime of its own request, so it takes no signal. The store
 * behind it stops a request the moment nothing reads the answer.
 *
 * @public
 */
export interface NarsilRequestSettings {
  /** The hook sends these headers with its request. */
  headers?: Record<string, string>
  /** The hook gives the server this many milliseconds to answer, and 0 waits
   * for as long as the server takes. */
  timeoutMs?: number
}

/**
 * These settings change what a read hook does, and every read hook takes them
 * as its last argument.
 *
 * @public
 */
export interface NarsilReadOptions extends NarsilRequestSettings {
  /** The hook sends nothing while this is false, and it reports no data and no
   * failure, which is how a search waits for a term. */
  enabled?: boolean
  /** The hook keeps showing the last answer while the next one loads, which
   * holds a result list steady as somebody types. */
  keepPreviousData?: boolean
  /** The hook asks again this often, in milliseconds, and it pauses while the
   * page is hidden. It asks once and stops unless you set this. */
  refreshIntervalMs?: number
}

/**
 * What a read hook reports.
 *
 * `isLoading` covers the wait for the first answer, so a spinner branches on
 * it, while `isFetching` covers every request including a refresh, so a quieter
 * indicator branches on that one.
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
  /** Calling this asks the server again, keeping the answer already on screen
   * until the new one arrives. */
  refresh: () => void
}

/**
 * Reads the per-request settings out of a hook's options, in the shape the
 * client takes them.
 *
 * @param settings - These are the options a hook was called with.
 * @returns The headers and the deadline go straight into a client call.
 */
export function requestOf(settings: NarsilRequestSettings | undefined): RequestOptions {
  return { headers: settings?.headers, timeoutMs: settings?.timeoutMs }
}
