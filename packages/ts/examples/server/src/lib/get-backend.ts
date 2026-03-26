const BACKEND_KEY = Symbol.for('narsil-server-backend')
const g = globalThis as unknown as Record<symbol, import('./server-backend').ServerBackend | undefined>

export async function getBackend() {
  if (g[BACKEND_KEY]) return g[BACKEND_KEY]
  const { ServerBackend } = await import('./server-backend')
  const instance = new ServerBackend()
  g[BACKEND_KEY] = instance
  return instance
}
