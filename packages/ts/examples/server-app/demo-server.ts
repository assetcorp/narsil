import path from 'node:path'
import process from 'node:process'
import type { EmbeddingAdapter } from '@delali/narsil'
import { createNarsil, registerLanguage } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'
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
import {
  type DemoNarsilServer,
  demoServerPromise,
  setDemoEngineStatus,
  setDemoServerPromise,
} from './src/lib/demo-server-state'
import { EMBEDDING_ADAPTER_NAME, readEmbeddingConfig } from './src/lib/embedding-config'

export type { DemoNarsilServer } from './src/lib/demo-server-state'

function apiKeyHook(apiKey: string): OnRequestHook {
  return ctx => {
    const header = ctx.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const presented = bearer ?? ctx.headers['x-api-key']
    if (presented === apiKey) return undefined
    return { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }
  }
}

function dataDirectory(): string {
  const override = process.env.NARSIL_DATA_DIR
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim())
  }
  return path.resolve(import.meta.dirname, '.narsil-data')
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

function embeddingAdaptersFromEnv(): Record<string, EmbeddingAdapter> | undefined {
  const config = readEmbeddingConfig()
  if (!config) return undefined
  return {
    [EMBEDDING_ADAPTER_NAME]: createOpenAIEmbedding({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      dimensions: config.dimensions,
    }),
  }
}

/** Exported so tests can run a full start-load-close-recover cycle; the dev
 * server uses the cached wrapper below. */
export async function startDemoNarsilServer(): Promise<DemoNarsilServer> {
  for (const language of [french, ewe, zulu, twi, yoruba, swahili, hausa, dagbani, igbo]) {
    registerLanguage(language)
  }

  /* Sync WAL mode would fsync per document; async risks at most the last
   * second of inserts, and the app checkpoints when each load completes. */
  const engine = await createNarsil({
    durability: { directory: dataDirectory(), mode: 'async' },
  })
  const apiKey = process.env.NARSIL_API_KEY
  const server = createServer(engine, {
    host: '127.0.0.1',
    port: portFromEnv(),
    onRequest: apiKey && apiKey.length > 0 ? apiKeyHook(apiKey) : undefined,
    embeddingAdapters: embeddingAdaptersFromEnv(),
  })
  await server.listen()
  return {
    url: `http://127.0.0.1:${server.listeningPort}`,
    async close() {
      await server.close()
      await engine.shutdown()
    },
  }
}

/**
 * Starts the local Narsil HTTP server that backs the demo when no external
 * server is configured. The instance is cached on globalThis so Vite config
 * reloads within one dev process reuse the running server instead of
 * competing for the port. Indexes persist under `.narsil-data` (override with
 * NARSIL_DATA_DIR) and are recovered on the next start, so loaded datasets
 * survive dev-server restarts. The directory has no cross-process lock; run
 * one dev server per data directory.
 *
 * NARSIL_SERVER_URL is set here, in a then-handler registered before any
 * other awaiter, so code that awaits the returned promise always finds the
 * URL in the environment. The status record backs /api/engine-status.
 */
export function ensureDemoNarsilServer(): Promise<DemoNarsilServer> {
  const existing = demoServerPromise()
  if (existing) return existing
  setDemoEngineStatus({ phase: 'starting' })
  const starting = startDemoNarsilServer()
  setDemoServerPromise(starting)
  starting
    .then(server => {
      process.env.NARSIL_SERVER_URL = server.url
      setDemoEngineStatus({ phase: 'ready' })
    })
    .catch((err: unknown) => {
      setDemoServerPromise(undefined)
      setDemoEngineStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    })
  return starting
}
