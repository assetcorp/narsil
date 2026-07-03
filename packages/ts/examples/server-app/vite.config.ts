import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { ensureDemoNarsilServer } from './demo-server'

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
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}

function narsilServerPlugin(): Plugin {
  return {
    name: 'narsil-demo-server',
    // Vitest also runs Vite in serve mode; the demo server must only back
    // interactive dev, and its open socket would keep the test runner alive.
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test',
    async configureServer() {
      const external = process.env.NARSIL_SERVER_URL
      if (external && external.trim().length > 0) {
        console.log(`[narsil] using the Narsil server at ${external}`)
        return
      }
      const { url } = await ensureDemoNarsilServer()
      process.env.NARSIL_SERVER_URL = url
      console.log(`[narsil] demo Narsil server listening at ${url}`)
    },
  }
}

function readRequestBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function streamingLoadPlugin(): Plugin {
  let viteServer: ViteDevServer

  return {
    name: 'streaming-load',
    configureServer(server) {
      viteServer = server

      server.middlewares.use('/api/batch-query', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = await readRequestBody(req)
          const { queries } = JSON.parse(body) as { queries: unknown[] }

          const mod = (await viteServer.ssrLoadModule('./src/lib/get-backend.ts')) as {
            getBackend: () => Promise<import('./src/lib/rest-backend').RestBackend>
          }
          const backend = await mod.getBackend()

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })

          for (let i = 0; i < queries.length; i++) {
            const response = await backend.query(queries[i] as Parameters<typeof backend.query>[0])
            res.write(`data: ${JSON.stringify({ i, response })}\n\n`)
          }

          res.end()
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          const message = err instanceof Error ? err.message : String(err)
          res.end(JSON.stringify({ error: message }))
        }
      })

      server.middlewares.use('/api/load', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = await readRequestBody(req)
          const request = JSON.parse(body)

          const mod = (await viteServer.ssrLoadModule('./src/lib/get-backend.ts')) as {
            getBackend: () => Promise<import('./src/lib/rest-backend').RestBackend>
          }
          const backend = await mod.getBackend()

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })

          const onProgress = (payload: unknown) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`)
          }

          backend.subscribe('progress', onProgress)

          try {
            await backend.loadDataset(request)
          } finally {
            backend.unsubscribe('progress', onProgress)
            res.end()
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          const message = err instanceof Error ? err.message : String(err)
          res.end(JSON.stringify({ error: message }))
        }
      })
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
