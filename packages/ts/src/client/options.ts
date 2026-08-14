/**
 * This is the `fetch` implementation the client sends every request through.
 *
 * It matches the global `fetch`, so pass one only to add a proxy agent, a retry
 * wrapper, or a stub in a test.
 *
 * @public
 */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>

/**
 * These are the settings {@link createNarsilClient} accepts.
 *
 * Only `url` is required. A client built from the address alone sends no
 * credentials, and it gives every request 30 seconds to answer.
 *
 * @public
 */
export interface NarsilClientOptions {
  /**
   * The server answers at this address. Pass an absolute URL such as
   * `https://search.example.com`, or a path such as `/search-api` when a
   * browser reaches the server through its own origin.
   */
  url: string
  /**
   * The client sends this key as `authorization: Bearer <key>`, which a server
   * reads in its `onRequest` hook. For any other scheme, set the header
   * yourself through {@link NarsilClientOptions.headers}.
   */
  apiKey?: string
  /** The client sends these headers with every request, and a per-call header of the same name replaces one. */
  headers?: Record<string, string>
  /**
   * The client waits this many milliseconds for an answer before it fails with
   * `CLIENT_REQUEST_TIMEOUT`, and it waits 30000 unless you say otherwise. Pass
   * 0 so that it waits for as long as the server takes. Three routes carry a
   * corpus or a whole index, so {@link BulkOperations.importDocuments},
   * {@link AdminOperations.snapshot}, and {@link AdminOperations.restore} set no
   * deadline of their own until this one arrives.
   */
  timeoutMs?: number
  /** The client sends every request through this instead of the global `fetch`. */
  fetch?: FetchFunction
}

/**
 * These settings change the one request a method sends.
 *
 * Every client method takes them as its last argument.
 *
 * @public
 */
export interface RequestOptions {
  /** Aborting this stops the request, which then fails with `CLIENT_REQUEST_ABORTED`. */
  signal?: AbortSignal
  /** The client waits this many milliseconds for this one answer, and 0 waits for as long as the server takes. */
  timeoutMs?: number
  /** The client adds these headers to this request, and one of the same name replaces what it would otherwise send. */
  headers?: Record<string, string>
}
