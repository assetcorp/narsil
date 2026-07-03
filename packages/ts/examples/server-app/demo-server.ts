import process from 'node:process'
import { createNarsil, registerLanguage } from '@delali/narsil'
import { dagbani } from '@delali/narsil/languages/dagbani'
import { ewe } from '@delali/narsil/languages/ewe'
import { french } from '@delali/narsil/languages/french'
import { hausa } from '@delali/narsil/languages/hausa'
import { igbo } from '@delali/narsil/languages/igbo'
import { swahili } from '@delali/narsil/languages/swahili'
import { twi } from '@delali/narsil/languages/twi'
import { yoruba } from '@delali/narsil/languages/yoruba'
import { zulu } from '@delali/narsil/languages/zulu'
import { createServer, type OnRequestHook } from '@delali/narsil/server'

export interface DemoNarsilServer {
  url: string
}

const STATE_KEY = Symbol.for('narsil-server-app-demo-server')
const g = globalThis as unknown as Record<symbol, Promise<DemoNarsilServer> | undefined>

function apiKeyHook(apiKey: string): OnRequestHook {
  return ctx => {
    const header = ctx.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const presented = bearer ?? ctx.headers['x-api-key']
    if (presented === apiKey) return undefined
    return { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }
  }
}

function portFromEnv(): number {
  const raw = process.env.NARSIL_PORT
  if (raw === undefined || raw.trim().length === 0) return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`NARSIL_PORT must be a port number, got "${raw}"`)
  }
  return value
}

async function start(): Promise<DemoNarsilServer> {
  for (const language of [french, ewe, zulu, twi, yoruba, swahili, hausa, dagbani, igbo]) {
    registerLanguage(language)
  }

  const engine = await createNarsil()
  const apiKey = process.env.NARSIL_API_KEY
  const server = createServer(engine, {
    host: '127.0.0.1',
    port: portFromEnv(),
    onRequest: apiKey && apiKey.length > 0 ? apiKeyHook(apiKey) : undefined,
  })
  await server.listen()
  return { url: `http://127.0.0.1:${server.listeningPort}` }
}

/**
 * Starts the local Narsil HTTP server that backs the demo when no external
 * server is configured. The instance is cached on globalThis so Vite config
 * reloads within one dev process reuse the running server instead of
 * competing for the port. It lives until the dev process exits; the index
 * data is in memory only.
 */
export function ensureDemoNarsilServer(): Promise<DemoNarsilServer> {
  const existing = g[STATE_KEY]
  if (existing) return existing
  const starting = start()
  g[STATE_KEY] = starting
  starting.catch(() => {
    g[STATE_KEY] = undefined
  })
  return starting
}
