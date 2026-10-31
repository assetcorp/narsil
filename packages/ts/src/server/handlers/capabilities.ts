import { SERVER_CAPABILITIES } from '../capabilities'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { CapabilitiesResponse } from '../types'

/**
 * Reports which optional routes and modes this server serves, so a client can
 * settle version skew before it sends a request rather than reading a 404 and
 * guessing. The list is static and carries no index or document data, which is
 * why it needs no API key, matching the health probes and `/version`.
 */
export function createCapabilitiesHandler() {
  function report(ctx: RouteContext): void {
    respondJson(ctx, { capabilities: [...SERVER_CAPABILITIES] } satisfies CapabilitiesResponse)
  }

  return { report }
}
