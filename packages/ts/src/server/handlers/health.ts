import type { HandlerDeps } from '../deps'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'

/**
 * Liveness answers 200 whenever the process can serve HTTP. Readiness answers
 * 503 until the engine is ready and again once shutdown begins, so a load
 * balancer drains the node before it stops accepting work.
 */
export function createHealthHandlers(deps: HandlerDeps) {
  function livez(ctx: RouteContext): void {
    respondJson(ctx, { status: 'ok' })
  }

  function readyz(ctx: RouteContext): void {
    if (deps.isReady()) {
      respondJson(ctx, { status: 'ready' })
    } else {
      respondJson(ctx, { status: 'unavailable' }, 503)
    }
  }

  return { livez, readyz }
}
