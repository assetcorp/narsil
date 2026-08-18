import { createNarsilClient, type NarsilClient } from '@delali/narsil/client'
import { demoServerPromise } from '../demo-server-state'
import { readServerConfig } from '../server-config'

const CLIENT_KEY = Symbol.for('narsil-server-app-client')
const store = globalThis as unknown as Record<symbol, NarsilClient | undefined>

const READ_TIMEOUT_MS = 30_000

/**
 * The client every server-side call goes through. It holds the API key, so it
 * never reaches the browser: the browser talks to this app instead, and the
 * proxy route passes the key on.
 */
export async function getNarsilClient(): Promise<NarsilClient> {
  const cached = store[CLIENT_KEY]
  if (cached) return cached

  const starting = demoServerPromise()
  if (starting) await starting

  const config = readServerConfig()
  const client = createNarsilClient({
    url: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: READ_TIMEOUT_MS,
  })
  store[CLIENT_KEY] = client
  return client
}
