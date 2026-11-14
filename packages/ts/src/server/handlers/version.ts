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
 * Reports the build identity of the running server, which is its version, the git
 * commit that it was built from, and a flag for a dirty working tree. The version is
 * the `build.version` that the caller passed, or else the version of the installed
 * `@delali/narsil` package, and the commit is null unless the caller passed one. The
 * report also names the path through which the answering
 * thread searches vector graphs. That path is the native search core where the
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
