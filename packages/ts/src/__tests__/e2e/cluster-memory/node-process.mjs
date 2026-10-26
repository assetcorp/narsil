import { createEtcdCoordinator } from '../../../../dist/distribution/coordinator/etcd.mjs'
import { createTcpTransport } from '../../../../dist/distribution/transport/tcp.mjs'
import { clusterNodeEngine, createClusterNode } from '../../../../dist/distribution.mjs'
import { createServer } from '../../../../dist/server.mjs'

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
const inFlightWriteFraction = process.env.NARSIL_IN_FLIGHT_WRITE_FRACTION

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
  memory: inFlightWriteFraction === undefined ? undefined : { inFlightWriteFraction: Number(inFlightWriteFraction) },
  onError: error => process.stderr.write(`${nodeId}: ${error.message}\n`),
})
await node.start()

const server = createServer(
  clusterNodeEngine(node, { createIndex: { partitionCount: 1, replicationFactor: 0, waitForServingMs: 30_000 } }),
  { host: '127.0.0.1', port: httpPort, cluster: node.cluster },
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
