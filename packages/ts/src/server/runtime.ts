import { ErrorCodes, NarsilError } from '../errors'

export type UWebSockets = typeof import('uWebSockets.js')

let cached: UWebSockets | null = null

/**
 * Loads uWebSockets.js, the optional peer that backs the HTTP server. Importing
 * `@delali/narsil/server` pulls in nothing until the server is started, so a
 * consumer of the core engine never needs this native dependency. A missing
 * install surfaces as a clear, actionable error rather than a module-not-found.
 */
export async function loadUWebSockets(): Promise<UWebSockets> {
  if (cached) return cached
  try {
    const mod = (await import('uWebSockets.js')) as UWebSockets & { default?: UWebSockets }
    const resolved = typeof mod.App === 'function' ? mod : mod.default
    if (!resolved || typeof resolved.App !== 'function') {
      throw new Error('uWebSockets.js did not expose an App factory')
    }
    cached = resolved
    return resolved
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'The `uWebSockets.js` package is required to run the Narsil HTTP server. Install it with `pnpm add github:uNetworking/uWebSockets.js#v20.58.0` (or the npm or yarn equivalent).',
      { cause: err instanceof Error ? err.message : String(err) },
    )
  }
}
