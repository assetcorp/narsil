import { type VectorSearchPath, vectorSearchPath } from '../../vector/native/search-path'
import type { HandlerDeps, ResolvedBuild } from '../deps'
import { respondJson } from '../handler-utils'
import type { RouteContext } from '../request'

export interface VersionReport extends ResolvedBuild {
  name: 'narsil'
  vectorSearch: VectorSearchPath
}

/**
 * Builds the `/version` body on the thread that answers the request, because each
 * thread loads the native search core for itself and falls back to WebAssembly on
 * its own after a native error.
 */
export function versionReport(build: ResolvedBuild): VersionReport {
  return { name: 'narsil', ...build, vectorSearch: vectorSearchPath() }
}

/**
 * Reports the build identity of the running server: its package version and the
 * git commit it was built from, with a flag for a dirty working tree. The values
 * are whatever the build stamped into the server; an unstamped build reports nulls
 * rather than guessing. The report also names the path through which the answering
 * thread searches vector graphs, which is the native search core where the thread
 * holds it and WebAssembly elsewhere. A benchmark or operator reads this to tie a
 * result to the exact code under test. It needs no API key, which is what the
 * health probes also do, so a probe or harness can reach it without a token.
 */
export function createVersionHandler(deps: HandlerDeps) {
  function report(ctx: RouteContext): void {
    respondJson(ctx, versionReport(deps.build))
  }

  return { report }
}
