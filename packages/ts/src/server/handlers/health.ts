import type { HandlerDeps } from '../deps'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { LivenessResponse, ReadinessResponse } from '../types'
import { describeNode } from './cluster'

/**
 * Liveness answers 200 whenever the process can serve HTTP. Readiness answers
 * 503 until the engine is ready and again once shutdown begins, so a load
 * balancer drains the node before it stops accepting work. A server fronting a
 * cluster node answers 200 only while that node reports `SERVING`, and its
 * body names the node and the readiness it reports either way.
 */
export function createHealthHandlers(deps: HandlerDeps) {
  function livez(ctx: RouteContext): void {
    respondJson(ctx, { status: 'ok' } satisfies LivenessResponse)
  }

  function readyz(ctx: RouteContext): void {
    const cluster = deps.cluster
    if (cluster === undefined) {
      if (deps.isReady()) {
        respondJson(ctx, { status: 'ready' } satisfies ReadinessResponse)
      } else {
        respondJson(ctx, { status: 'unavailable' } satisfies ReadinessResponse, 503)
      }
      return
    }

    const readiness = cluster.getReadiness()
    const ready = deps.isReady() && readiness === 'SERVING'
    respondJson(
      ctx,
      {
        status: ready ? 'ready' : 'unavailable',
        cluster: describeNode(cluster),
      } satisfies ReadinessResponse,
      ready ? 200 : 503,
    )
  }

  return { livez, readyz }
}
