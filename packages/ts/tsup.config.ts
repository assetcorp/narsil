import { readdirSync } from 'node:fs'
import { defineConfig, type Options } from 'tsup'

const NODE_BUILTINS = ['worker_threads', 'fs', 'path', 'os', 'crypto', 'net', 'tls']
const NODE_EXTERNAL = NODE_BUILTINS.flatMap(m => [m, `node:${m}`])
const OPTIONAL_PEERS = ['etcd3', 'uWebSockets.js']

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

const nodeEntry: Record<string, string> = {
  index: 'src/index.ts',
  'adapters/memory': 'src/persistence/memory.ts',
  'adapters/filesystem': 'src/persistence/filesystem.ts',
  'adapters/indexeddb': 'src/persistence/indexeddb.ts',
  'invalidation/noop': 'src/invalidation/noop.ts',
  'invalidation/filesystem': 'src/invalidation/filesystem.ts',
  'invalidation/broadcast-channel': 'src/invalidation/broadcast-channel.ts',
  'workers/entry': 'src/workers/worker-entry.ts',
  'vector/hnsw-build-worker': 'src/vector/hnsw-build-worker.ts',
  'vector/search-worker': 'src/vector/search-worker.ts',
  'serialization/crc32-worker': 'src/serialization/crc32-worker.ts',
  'persistence/durability/checkpoint-worker': 'src/persistence/durability/checkpoint-worker.ts',
  'embeddings/openai': 'src/embeddings/openai.ts',
  ...languageEntries(),
  distribution: 'src/distribution/index.ts',
  'distribution/coordinator/in-memory': 'src/distribution/coordinator/in-memory.ts',
  'distribution/coordinator/etcd': 'src/distribution/coordinator/etcd/index.ts',
  'distribution/transport/tcp': 'src/distribution/transport/tcp/index.ts',
  'distribution/transport/in-memory': 'src/distribution/transport/in-memory.ts',
  server: 'src/server/index.ts',
}

const browserEntry: Record<string, string> = { client: 'src/client/index.ts', react: 'src/react/index.ts' }

const shared: Options = {
  format: ['esm'],
  treeshake: true,
  clean: false,
  outExtension: () => ({ js: '.mjs' }),
}

export default defineConfig([
  {
    ...shared,
    entry: nodeEntry,
    platform: 'node',
    dts: false,
    splitting: true,
    external: [...NODE_EXTERNAL, ...OPTIONAL_PEERS],
  },
  {
    ...shared,
    entry: { 'index.browser': 'src/index.ts' },
    dts: false,
    splitting: false,
    external: NODE_EXTERNAL,
    esbuildOptions(options) {
      options.conditions = ['browser', 'import']
    },
  },
  {
    ...shared,
    entry: browserEntry,
    platform: 'browser',
    dts: false,
    splitting: false,
    external: NODE_EXTERNAL,
  },
  {
    ...shared,
    entry: { ...nodeEntry, ...browserEntry },
    platform: 'neutral',
    dts: { only: true },
    splitting: true,
    external: [...NODE_EXTERNAL, ...OPTIONAL_PEERS],
  },
])
