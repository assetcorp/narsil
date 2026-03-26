import type { ServerBackend } from './server-backend'

const BACKEND_KEY = Symbol.for('narsil-server-backend')
const g = globalThis as unknown as Record<symbol, ServerBackend | undefined>

export async function getBackend(): Promise<ServerBackend> {
  const cached = g[BACKEND_KEY]
  if (cached) return cached
  const mod = await import('./server-backend')
  const instance = new mod.ServerBackend()
  g[BACKEND_KEY] = instance
  return instance
}
