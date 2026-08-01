import { readdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

const NODE_BUILTINS = ['worker_threads', 'fs', 'path', 'os', 'crypto', 'net', 'tls']
const NODE_EXTERNAL = NODE_BUILTINS.flatMap(m => [m, `node:${m}`])

const LANGUAGES_DIR = 'src/languages'
const NON_LANGUAGE_MODULES = new Set(['registry'])

function languageEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const file of readdirSync(LANGUAGES_DIR).sort()) {
    if (!file.endsWith('.ts')) continue
    const name = file.slice(0, -3)
    if (NON_LANGUAGE_MODULES.has(name)) continue
    entries[`languages/${name}`] = `${LANGUAGES_DIR}/${file}`
  }
  return entries
}

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'adapters/memory': 'src/persistence/memory.ts',
      'adapters/filesystem': 'src/persistence/filesystem.ts',
      'adapters/indexeddb': 'src/persistence/indexeddb.ts',
      'invalidation/noop': 'src/invalidation/noop.ts',
      'invalidation/filesystem': 'src/invalidation/filesystem.ts',
      'invalidation/broadcast-channel': 'src/invalidation/broadcast-channel.ts',
      'workers/entry': 'src/workers/worker-entry.ts',
      'vector/hnsw-build-worker': 'src/vector/hnsw-build-worker.ts',
      'serialization/crc32-worker': 'src/serialization/crc32-worker.ts',
      'persistence/durability/checkpoint-worker': 'src/persistence/durability/checkpoint-worker.ts',
      'embeddings/openai': 'src/embeddings/openai.ts',
      ...languageEntries(),
      distribution: 'src/distribution/index.ts',
      'distribution/coordinator/in-memory': 'src/distribution/coordinator/in-memory.ts',
      'distribution/coordinator/etcd': 'src/distribution/coordinator/etcd/index.ts',
      server: 'src/server/index.ts',
    },
    format: ['esm'],
    dts: true,
    splitting: true,
    clean: true,
    treeshake: true,
    outExtension: () => ({ js: '.mjs' }),
    external: [...NODE_EXTERNAL, 'etcd3', 'uWebSockets.js'],
  },
  {
    entry: { 'index.browser': 'src/index.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    treeshake: true,
    outExtension: () => ({ js: '.mjs' }),
    external: NODE_EXTERNAL,
    esbuildOptions(options) {
      options.conditions = ['browser', 'import']
    },
  },
])
