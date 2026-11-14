import { vectorSearchPath } from '../../vector/native/search-path'
import type { HandlerDeps, ResolvedBuild } from '../deps'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { VersionResponse } from '../types'

/**
 * Builds the `/version` body on the thread that answers the request, because each
 * thread loads the native search core for itself and falls back to WebAssembly on
 * its own after a native error.
 */
export function versionReport(build: ResolvedBuild): VersionResponse {
  return { name: 'narsil', ...build, vectorSearch: vectorSearchPath() }
}

/**
 * This handler reports the build identity of the running server, which is its
 * version, the git commit of its build, and a flag that marks a dirty working tree.
 * The handler takes the version from the `build.version` that the caller passes to
 * `createServer`, or else from the installed `@delali/narsil` package, while it
 * reports a null commit unless the caller passes one. The handler also reports the
 * path through which the answering thread searches vector graphs. That path is the native search core where the
 * thread holds one, and WebAssembly elsewhere. A benchmark or operator reads this
 * to tie a result to the exact code under test. It needs no API key, which is what
 * the health probes also do, so a probe or harness can reach it without a token.
 */
export function createVersionHandler(deps: HandlerDeps) {
  function report(ctx: RouteContext): void {
    respondJson(ctx, versionReport(deps.build))
  }

  return { report }
}
