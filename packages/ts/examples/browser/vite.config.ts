import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { SERVER_APP_PATH_PREFIX, SERVER_APP_SYNC_FEED_PATTERN } from './src/lib/server-app-path'

const monorepoRoot = path.resolve(import.meta.dirname, '../../../..')
const dataDir = path.join(monorepoRoot, 'data', 'processed')
const DEFAULT_SERVER_APP_URL = 'http://localhost:3000'
const serverAppUrl = process.env.NARSIL_SERVER_APP_URL ?? DEFAULT_SERVER_APP_URL

function withoutServerAppPrefix(url: string): string {
  return url.slice(SERVER_APP_PATH_PREFIX.length)
}

function serveDataPlugin(): Plugin {
  return {
    name: 'serve-data-files',
    configureServer(server) {
      server.middlewares.use('/data/processed', (req, res, next) => {
        const urlPath = decodeURIComponent(req.url ?? '/')
        const filePath = path.resolve(dataDir, urlPath.replace(/^\//, ''))

        if (!filePath.startsWith(`${dataDir}${path.sep}`)) {
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

const config = defineConfig({
  plugins: [
    serveDataPlugin(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: [
      '@delali/narsil-embeddings-transformers',
      '@delali/narsil-embeddings-transformers/reranker',
      '@huggingface/transformers',
      'valibot',
    ],
  },
  server: {
    fs: {
      allow: [monorepoRoot],
    },
    proxy: {
      [SERVER_APP_SYNC_FEED_PATTERN]: {
        target: serverAppUrl,
        changeOrigin: true,
        ws: true,
        rewrite: withoutServerAppPrefix,
      },
      [`^${SERVER_APP_PATH_PREFIX}/`]: {
        target: serverAppUrl,
        changeOrigin: true,
        ws: false,
        rewrite: withoutServerAppPrefix,
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
})

export default config
