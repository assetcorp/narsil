import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
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
        // pipeline destroys both streams when either side fails (a client
        // leaving mid-download would otherwise crash the dev process through
        // an unconsumed response 'error' and leak the file descriptor).
        pipeline(fs.createReadStream(filePath), res, () => {})
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
    configureServer() {
      const external = process.env.NARSIL_SERVER_URL
      if (external && external.trim().length > 0) {
        console.log(`[narsil] using the Narsil server at ${external}`)
        return
      }
      /* Recovering persisted indexes can take a while; starting the demo
       * server without awaiting lets Vite listen immediately while the app
       * reports that the search server is not answering yet. */
      ensureDemoNarsilServer()
        .then(({ url }) => {
          console.log(`[narsil] demo Narsil server listening at ${url}`)
        })
        .catch((err: unknown) => {
          console.error(
            `[narsil] the demo Narsil server failed to start: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
    },
  }
}

const config = defineConfig({
  plugins: [
    narsilServerPlugin(),
    serveDataPlugin(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] }), viteReact()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
        },
      },
    ],
  },
})

export default config
