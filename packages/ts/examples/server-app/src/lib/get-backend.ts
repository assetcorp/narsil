import { demoServerPromise } from './demo-server-state'
import type { RestBackend } from './rest-backend'

const BACKEND_KEY = Symbol.for('narsil-server-app-backend')
const g = globalThis as unknown as Record<symbol, RestBackend | undefined>

export async function getBackend(): Promise<RestBackend> {
  const cached = g[BACKEND_KEY]
  if (cached) return cached
  /* While the bundled demo server is still recovering persisted indexes,
   * requests wait for it instead of failing on a missing NARSIL_SERVER_URL. */
  const pending = demoServerPromise()
  if (pending) await pending
  const [backendModule, configModule] = await Promise.all([import('./rest-backend'), import('./server-config')])
  const instance = new backendModule.RestBackend(configModule.readServerConfig())
  g[BACKEND_KEY] = instance
  return instance
}
