import type { RestBackend } from './rest-backend'

const BACKEND_KEY = Symbol.for('narsil-server-app-backend')
const g = globalThis as unknown as Record<symbol, RestBackend | undefined>

export async function getBackend(): Promise<RestBackend> {
  const cached = g[BACKEND_KEY]
  if (cached) return cached
  const [backendModule, configModule] = await Promise.all([import('./rest-backend'), import('./server-config')])
  const instance = new backendModule.RestBackend(configModule.readServerConfig())
  g[BACKEND_KEY] = instance
  return instance
}
