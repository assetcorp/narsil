/**
 * The `fetch` implementation the client sends every request with.
 *
 * It matches the global `fetch`. Pass one to add a proxy agent, a retry
 * wrapper, or a stub in a test.
 *
 * @public
 */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>

/**
 * Everything {@link createNarsilClient} accepts.
 *
 * Only `url` is required. A client built with nothing else sends no
 * credentials, and it waits 30 seconds for each answer.
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
   * The client sends this key as `authorization: Bearer <key>`, which is the
   * scheme the `onRequest` hook checks in Narsil's own examples. For any other
   * scheme, set the header yourself through
   * {@link NarsilClientOptions.headers}.
   */
  apiKey?: string
  /** The client sends these headers with every request. A per-call header of the same name replaces one. */
  headers?: Record<string, string>
  /**
   * The client waits this many milliseconds for an answer, then fails with
   * `CLIENT_REQUEST_TIMEOUT`. Pass 0 to wait for as long as the server takes.
   * It defaults to 30000. The three routes that carry a corpus or a snapshot
   * ({@link BulkOperations.importDocuments}, {@link AdminOperations.snapshot},
   * and {@link AdminOperations.restore}) set no deadline of their own, so they
   * wait until you set this.
   */
  timeoutMs?: number
  /** The client sends every request through this instead of the global `fetch`. */
  fetch?: FetchFunction
}

/**
 * What one call changes about the request it sends.
 *
 * Every client method takes this as its last argument.
 *
 * @public
 */
export interface RequestOptions {
  /** Aborting this stops the request, which then fails with `CLIENT_REQUEST_ABORTED`. */
  signal?: AbortSignal
  /** The client waits this many milliseconds for this one answer, and 0 waits for as long as the server takes. */
  timeoutMs?: number
  /** The client adds these headers to this request, replacing any of the same name it would otherwise send. */
  headers?: Record<string, string>
}
