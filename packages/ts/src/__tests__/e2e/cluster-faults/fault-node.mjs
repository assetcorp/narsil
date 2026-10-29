import { createEtcdCoordinator } from '../../../../dist/distribution/coordinator/etcd.mjs'
import { createTcpTransport } from '../../../../dist/distribution/transport/tcp.mjs'
import { clusterNodeEngine, createClusterNode } from '../../../../dist/distribution.mjs'
import { createServer } from '../../../../dist/server.mjs'

const settings = JSON.parse(process.env.NARSIL_FAULT_NODE ?? '{}')

const coordinator = await createEtcdCoordinator({
  endpoints: settings.etcdEndpoints,
  keyPrefix: settings.keyPrefix,
  nodeHeartbeatTtlSeconds: settings.heartbeatTtlSeconds,
  ...(settings.etcdTls === undefined ? {} : { tls: settings.etcdTls }),
  ...(settings.etcdAuth === undefined ? {} : { auth: settings.etcdAuth }),
})
const transport = createTcpTransport('fault-node', {
  host: '127.0.0.1',
  port: settings.transportPort,
  ...(settings.transportTls === undefined ? {} : { tls: settings.transportTls }),
})
const node = await createClusterNode({
  coordinator,
  transport,
  address: `127.0.0.1:${settings.advertisedPort}`,
  ...(settings.nodeId === undefined ? {} : { nodeId: settings.nodeId }),
  roles: ['data', 'coordinator', 'controller'],
  engine: { workers: { enabled: false }, durability: { directory: settings.directory } },
  controller: { leaseTtlMs: settings.controllerLeaseTtlMs, standbyRetryMs: settings.standbyRetryMs },
  onError: error => process.stderr.write(`${node.nodeId}: ${error.message}\n`),
})
await node.start()

const server = createServer(
  clusterNodeEngine(node, {
    createIndex: {
      partitionCount: settings.partitionCount,
      replicationFactor: settings.replicationFactor,
      waitForServingMs: settings.waitForServingMs,
    },
  }),
  { host: '127.0.0.1', port: settings.httpPort, cluster: node.cluster },
)
await server.listen()
process.stdout.write(`READY ${node.nodeId}\n`)

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
