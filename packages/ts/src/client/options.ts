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
   * browser reaches the server through its own origin. Pass a list of them,
   * such as the address of every node in a cluster, so that the client moves
   * on when one of them fails. An empty list, or one that holds an address the
   * client cannot read, fails with `CONFIG_INVALID`.
   *
   * A client takes one server URL or a list of them. It sends each request to
   * one URL, starting one place after the URL that took the previous request,
   * so that requests spread across the list.
   *
   * The client moves a request to the next URL when the connection fails, when
   * the request times out, or when the server answers 502, 503, or 504. It
   * tries each URL at most once as it moves down the list, and it fails with
   * the error from its last try once every URL has failed. `timeoutMs` applies
   * to each try.
   *
   * The client tries a read once more when every URL has failed its connection
   * or answered 502, 503, or 504, so a list of N URLs can take N + 1 requests.
   * With one URL, the second try goes to that same URL. The client sends the
   * extra try straight away, to the first URL in the skip order below. A read
   * that timed out on any URL takes no extra try.
   *
   * The client repeats a request on another URL only where repeating it cannot
   * apply a change twice. A read, meaning a get, a search, a listing, or a
   * stats call, moves on after any of the failures above. A write moves on only
   * where the client sent no byte of it, because the connection was refused or
   * the name did not resolve, or where the server refused it with
   * `NODE_NOT_READY`. A write that times out, or that a server answers with
   * 502, 503, or 504, fails without being sent again, so that the caller
   * decides whether to resend it. A request whose body is a stream goes to one
   * URL alone, because the client cannot read the stream a second time. A
   * browser reports no reason for a failed connection, so a write that a
   * browser sends moves on only after a `NODE_NOT_READY` answer.
   *
   * After a URL refuses a connection, the client skips it for
   * {@link NarsilClientOptions.urlSkipMs}, 1,000 milliseconds unless you say
   * otherwise, then for twice as long after each further refusal, up to
   * {@link NarsilClientOptions.maxUrlSkipMs}, 30,000 milliseconds unless you
   * say otherwise, and it uses it again once the URL answers with any status
   * other than 502, 503, or 504. When
   * every URL is in its skip period, the client tries the one whose skip period
   * ends first.
   */
  url: string | readonly string[]
  /**
   * The client skips a URL for this many milliseconds after it refuses a
   * connection, and for twice as long after each further refusal. It skips
   * one for 1000 unless you say otherwise.
   */
  urlSkipMs?: number
  /**
   * The client never skips a URL for longer than this many milliseconds, and
   * it stops at 30000 unless you say otherwise. It must be at least
   * {@link NarsilClientOptions.urlSkipMs}.
   */
  maxUrlSkipMs?: number
  /**
   * The client sends this key as `authorization: Bearer <key>`, which a server
   * reads in its `onRequest` hook. For any other scheme, set the header
   * yourself through {@link NarsilClientOptions.headers}.
   */
  apiKey?: string
  /** The client sends these headers with every request, and a per-call header of the same name replaces one. */
  headers?: Record<string, string>
  /**
   * The client waits this many milliseconds for an answer on each try before it
   * fails with `CLIENT_REQUEST_TIMEOUT`, and it waits 30000 unless you say
   * otherwise, so a read that tries again can take longer than this in total.
   * Pass 0 so that it waits for as long as the server takes. Three routes carry a
   * corpus or a whole index, so {@link BulkOperations.importDocuments},
   * {@link AdminOperations.snapshot}, and {@link AdminOperations.restore} set no
   * deadline of their own until this one arrives.
   */
  timeoutMs?: number
  /** The client sends every request through this instead of the global `fetch`. */
  fetch?: FetchFunction
  /**
   * The client stops reading an answer once it passes this many bytes, and
   * fails with `CLIENT_INVALID_RESPONSE` rather than holding the rest. Set it
   * where the client runs somewhere a runaway answer would matter, such as a
   * browser tab, and leave it out to read whatever the server sends. A
   * snapshot download reads the whole index, so give it its own ceiling
   * through {@link RequestOptions.maxResponseBytes} or none at all.
   */
  maxResponseBytes?: number
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
  /** The client waits this many milliseconds on each try of this one request, and 0 waits for as long as the server takes. */
  timeoutMs?: number
  /** The client adds these headers to this request, and one of the same name replaces what it would otherwise send. */
  headers?: Record<string, string>
  /** The client stops reading this one answer past this many bytes, and 0 reads whatever the server sends. */
  maxResponseBytes?: number
}
