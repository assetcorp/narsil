import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

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

const config = defineConfig({
  plugins: [
    serveDataPlugin(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
})

export default config
