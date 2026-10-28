import { getHeapSpaceStatistics } from 'node:v8'
import { createEtcdCoordinator } from '../../../../dist/distribution/coordinator/etcd.mjs'
import { createTcpTransport } from '../../../../dist/distribution/transport/tcp.mjs'
import { clusterNodeEngine, createClusterNode } from '../../../../dist/distribution.mjs'
import { registerLanguage, registerTokenizer } from '../../../../dist/index.mjs'
import { chinese } from '../../../../dist/languages/chinese.mjs'
import { createServer } from '../../../../dist/server.mjs'

const SHINGLE_LENGTH = 3
const OLD_GENERATION_SAMPLE_INTERVAL_MS = 20
const YOUNG_GENERATION_SPACES = new Set(['new_space', 'new_large_object_space'])

let peakOldGenerationBytes = 0
function sampleOldGeneration() {
  let used = 0
  for (const space of getHeapSpaceStatistics()) {
    if (!YOUNG_GENERATION_SPACES.has(space.space_name)) used += space.space_used_size
  }
  peakOldGenerationBytes = Math.max(peakOldGenerationBytes, used)
}
setInterval(sampleOldGeneration, OLD_GENERATION_SAMPLE_INTERVAL_MS).unref()
process.on('SIGUSR2', () => {
  sampleOldGeneration()
  process.stdout.write(`PEAK_OLD_GENERATION ${peakOldGenerationBytes}\n`)
})

registerLanguage(chinese)
registerTokenizer('three-character-shingles', {
  tokenize: text => {
    const tokens = []
    for (let position = 0; position + SHINGLE_LENGTH <= text.length; position++) {
      tokens.push({ token: text.slice(position, position + SHINGLE_LENGTH), position })
    }
    return tokens
  },
})

function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    process.stderr.write(`missing ${name}\n`)
    process.exit(2)
  }
  return value
}

const nodeId = requireEnv('NARSIL_NODE_ID')
const transportPort = Number(requireEnv('NARSIL_TRANSPORT_PORT'))
const httpPort = Number(requireEnv('NARSIL_HTTP_PORT'))
const memoryConfig = process.env.NARSIL_MEMORY_CONFIG
const serverLimits = process.env.NARSIL_SERVER_LIMITS

const coordinator = await createEtcdCoordinator({
  endpoints: [requireEnv('NARSIL_ETCD_ENDPOINT')],
  keyPrefix: requireEnv('NARSIL_ETCD_KEY_PREFIX'),
  nodeHeartbeatTtlSeconds: 10,
})
const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port: transportPort })
const node = await createClusterNode({
  coordinator,
  transport,
  address: `127.0.0.1:${transportPort}`,
  nodeId,
  roles: ['data', 'coordinator', 'controller'],
  engine: { workers: { enabled: false } },
  controller: { leaseTtlMs: 5_000, standbyRetryMs: 1_000 },
  memory: memoryConfig === undefined ? undefined : JSON.parse(memoryConfig),
  onError: error => process.stderr.write(`${nodeId}: ${error.message}\n`),
})
await node.start()

const server = createServer(
  clusterNodeEngine(node, { createIndex: { partitionCount: 1, replicationFactor: 0, waitForServingMs: 30_000 } }),
  {
    host: '127.0.0.1',
    port: httpPort,
    cluster: node.cluster,
    limits: serverLimits === undefined ? undefined : JSON.parse(serverLimits),
  },
)
await server.listen()
process.stdout.write(`READY ${nodeId}\n`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.close()
  await node.shutdown()
  await transport.shutdown()
  await coordinator.shutdown()
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
