import { ServerErrorCodes } from '../errors'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { readArray, readBody } from './response-shape'

/**
 * What a server reports about the build it is running, so you can tie a result
 * or an incident to the exact code that produced it.
 *
 * The values are whatever the build stamped in, so an unstamped build reports
 * nulls.
 *
 * @public
 */
export interface ServerVersion {
  /** This names the product, and is always `narsil`. */
  name: string
  /** The server was built from this package version. */
  version: string | null
  /** The server was built from this git commit. */
  gitSha: string | null
  /** This is true when the working tree held uncommitted changes at build time. */
  dirty: boolean
}

/**
 * Asking a server what it is and what it serves, before asking it for any work.
 *
 * Every route here answers without credentials, so a probe or a health check
 * reaches them without a key.
 *
 * @public
 */
export interface ServerOperations {
  /**
   * Reports the build the server is running.
   *
   * @param options - Per-call signal, deadline, and headers.
   * @returns The package version and commit the server was built from.
   */
  version(options?: RequestOptions): Promise<ServerVersion>
  /**
   * Lists the optional routes and modes this server serves.
   *
   * A server that predates a capability leaves it out. One that predates the
   * whole endpoint reports an empty list, and the call still succeeds.
   *
   * @param options - Per-call signal, deadline, and headers.
   * @returns Each capability the server announces.
   */
  capabilities(options?: RequestOptions): Promise<string[]>
  /**
   * Reports whether the server serves one optional capability, such as
   * `ASYNC_IMPORT_CAPABILITY`.
   *
   * The client reads the answer once and keeps it for its own lifetime, because
   * a server cannot take on a capability without restarting.
   *
   * @param capability - The capability to ask about.
   * @param options - Per-call signal, deadline, and headers, used only when the
   * answer is not already known.
   * @returns True when the server announced it.
   */
  supports(capability: string, options?: RequestOptions): Promise<boolean>
  /**
   * Reports whether the server is answering HTTP at all.
   *
   * @param options - Per-call signal, deadline, and headers.
   * @returns True when the liveness probe answered.
   * @throws A `NarsilError` with `CLIENT_CONNECTION_FAILED` when the client
   * cannot reach the server, which is a different failure from a server that
   * answers and reports itself unready.
   */
  isAlive(options?: RequestOptions): Promise<boolean>
  /**
   * Reports whether the server is ready to take work, which turns false while
   * it starts up and again once it starts draining.
   *
   * @param options - Per-call signal, deadline, and headers.
   * @returns True when the readiness probe answered ready.
   * @throws A `NarsilError` with `CLIENT_CONNECTION_FAILED` when the client
   * cannot reach the server.
   */
  isReady(options?: RequestOptions): Promise<boolean>
}

export function createServerOperations(transport: Transport): ServerOperations {
  let announced: Promise<Set<string>> | null = null

  async function readCapabilities(options: RequestOptions | undefined): Promise<Set<string>> {
    const path = '/capabilities'
    const payload = await transport.jsonOrNull({ method: 'GET', path, options }, ServerErrorCodes.NOT_FOUND)
    if (payload === null) return new Set()
    return new Set(readArray<string>(payload, 'capabilities', path))
  }

  function load(options: RequestOptions | undefined): Promise<Set<string>> {
    if (announced === null) {
      announced = readCapabilities(options).catch((err: unknown) => {
        announced = null
        throw err
      })
    }
    return announced
  }

  return {
    async version(options) {
      const path = '/version'
      return readBody<ServerVersion>(await transport.json({ method: 'GET', path, options }), path)
    },
    async capabilities(options) {
      return [...(await load(options))]
    },
    async supports(capability, options) {
      return (await load(options)).has(capability)
    },
    async isAlive(options) {
      return (await transport.probe({ method: 'GET', path: '/livez', options })) === 200
    },
    async isReady(options) {
      return (await transport.probe({ method: 'GET', path: '/readyz', options })) === 200
    },
  }
}
