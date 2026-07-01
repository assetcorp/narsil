import type { HandlerDeps } from '../deps'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'

/**
 * Reports the build identity of the running server: its package version and the
 * git commit it was built from, with a flag for a dirty working tree. The values
 * are whatever the build stamped into the server; an unstamped build reports nulls
 * rather than guessing. A benchmark or operator reads this to tie a result to the
 * exact code under test. It needs no API key, so it sits alongside the health
 * probes and a probe or harness can reach it without a token.
 */
export function createVersionHandler(deps: HandlerDeps) {
  function report(ctx: RouteContext): void {
    respondJson(ctx, { name: 'narsil', ...deps.build })
  }

  return { report }
}
