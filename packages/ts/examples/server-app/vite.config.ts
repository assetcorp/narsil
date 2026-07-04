import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { ensureDemoNarsilServer } from './demo-server'
import { demoEngineStatus } from './src/lib/demo-server-state'
import type { EngineStatus } from './src/lib/engine-status'
import { openSseSession } from './sse'

const monorepoRoot = path.resolve(import.meta.dirname, '../../../..')
const dataDir = path.join(monorepoRoot, 'data', 'processed')

function serveDataPlugin(): Plugin {
  return {
    name: 'serve-data-files',
    configureServer(server) {
      server.middlewares.use('/data/processed', (req, res, next) => {
        const urlPath = decodeURIComponent(req.url ?? '/')
        const filePath = path.resolve(dataDir, urlPath.replace(/^\//, ''))

        if (!filePath.startsWith(dataDir)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          next()
          return
        }

        const stat = fs.statSync(filePath)
        res.setHeader('Content-Length', stat.size)
        if (filePath.endsWith('.json')) {
          res.setHeader('Content-Type', 'application/json')
        }
        // pipeline destroys both streams when either side fails (a client
        // leaving mid-download would otherwise crash the dev process through
        // an unconsumed response 'error' and leak the file descriptor).
        pipeline(fs.createReadStream(filePath), res, () => {})
      })
    },
  }
}

function respondEngineStatus(res: ServerResponse): void {
  const status: EngineStatus = demoEngineStatus() ?? { phase: process.env.NARSIL_SERVER_URL ? 'ready' : 'starting' }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(status))
}

function narsilServerPlugin(): Plugin {
  return {
    name: 'narsil-demo-server',
    // Vitest also runs Vite in serve mode; the demo server must only back
    // interactive dev, and its open socket would keep the test runner alive.
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test',
    configureServer(server) {
      server.middlewares.use('/api/engine-status', (req, res, next) => {
        if (req.method !== 'GET') {
          next()
          return
        }
        respondEngineStatus(res)
      })

      const external = process.env.NARSIL_SERVER_URL
      if (external && external.trim().length > 0) {
        console.log(`[narsil] using the Narsil server at ${external}`)
        return
      }
      /* Recovering persisted indexes can take a while; starting the demo
       * server without awaiting lets Vite listen immediately while the app
       * shows recovery progress from /api/engine-status. */
      ensureDemoNarsilServer()
        .then(({ url }) => {
          console.log(`[narsil] demo Narsil server listening at ${url}`)
        })
        .catch((err: unknown) => {
          console.error(`[narsil] the demo Narsil server failed to start: ${errorMessage(err)}`)
        })
    },
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf-8'))))
    req.on('error', err => settle(() => reject(err)))
    // Without this a connection dropped mid-body leaves the promise pending
    // forever, holding the handler and its captured buffers alive.
    req.on('close', () => settle(() => reject(new Error('The connection closed before the request body finished'))))
  })
}

type BackendModule = {
  getBackend: () => Promise<import('./src/lib/rest-backend').RestBackend>
}

type RestBackendInstance = Awaited<ReturnType<BackendModule['getBackend']>>

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function respondJsonError(res: ServerResponse, message: string): void {
  if (res.writableEnded || res.destroyed) return
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

async function loadBackend(viteServer: ViteDevServer): Promise<RestBackendInstance> {
  const mod = (await viteServer.ssrLoadModule('./src/lib/get-backend.ts')) as BackendModule
  return mod.getBackend()
}

type LoadJobsModule = typeof import('./src/lib/load-jobs')

async function loadJobs(viteServer: ViteDevServer): Promise<LoadJobsModule> {
  return (await viteServer.ssrLoadModule('./src/lib/load-jobs.ts')) as LoadJobsModule
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function handleLoadStart(viteServer: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = JSON.parse(await readRequestBody(req)) as Parameters<LoadJobsModule['startLoadJob']>[0]
    const jobs = await loadJobs(viteServer)
    respondJson(res, 202, jobs.startLoadJob(request))
  } catch (err) {
    respondJsonError(res, errorMessage(err))
  }
}

async function handleLoadStatus(viteServer: ViteDevServer, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const jobs = await loadJobs(viteServer)
    respondJson(res, 200, { jobs: jobs.listLoadJobs() })
  } catch (err) {
    respondJsonError(res, errorMessage(err))
  }
}

async function handleLoadCancel(viteServer: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = JSON.parse(await readRequestBody(req)) as { datasetId?: string }
    if (typeof request.datasetId !== 'string') {
      throw new Error('The request body must contain a "datasetId" string')
    }
    const jobs = await loadJobs(viteServer)
    respondJson(res, 200, { cancelled: jobs.cancelLoadJob(request.datasetId) })
  } catch (err) {
    respondJsonError(res, errorMessage(err))
  }
}

async function handleBatchQueryRequest(
  viteServer: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let queries: unknown[]
  let backend: RestBackendInstance
  try {
    const parsed = JSON.parse(await readRequestBody(req)) as { queries?: unknown[] }
    if (!Array.isArray(parsed.queries)) {
      throw new Error('The request body must contain a "queries" array')
    }
    queries = parsed.queries
    backend = await loadBackend(viteServer)
  } catch (err) {
    respondJsonError(res, errorMessage(err))
    return
  }

  const session = openSseSession(req, res)
  try {
    for (let i = 0; i < queries.length; i++) {
      if (session.signal.aborted) break
      const response = await backend.query(queries[i] as Parameters<RestBackendInstance['query']>[0])
      const delivered = await session.send({ i, response })
      if (!delivered) break
    }
    session.close()
  } catch (err) {
    session.fail({ error: errorMessage(err) })
  }
}

function streamingLoadPlugin(): Plugin {
  return {
    name: 'streaming-load',
    configureServer(server) {
      const route = (method: string, handler: typeof handleBatchQueryRequest) => {
        return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (req.method !== method) {
            next()
            return
          }
          // An unconsumed response 'error' event would crash the dev process;
          // openSseSession aborts in-flight work on the same event.
          res.on('error', () => {})
          void handler(server, req, res)
        }
      }

      server.middlewares.use('/api/batch-query', route('POST', handleBatchQueryRequest))
      server.middlewares.use('/api/load-status', route('GET', handleLoadStatus))
      server.middlewares.use('/api/load-cancel', route('POST', handleLoadCancel))
      server.middlewares.use('/api/load', route('POST', handleLoadStart))
    },
  }
}

const config = defineConfig({
  plugins: [
    narsilServerPlugin(),
    serveDataPlugin(),
    streamingLoadPlugin(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
