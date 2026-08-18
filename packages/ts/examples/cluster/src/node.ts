import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clusterNodeEngine, createClusterNode } from '@delali/narsil/distribution'
import { createEtcdCoordinator } from '@delali/narsil/distribution/coordinator/etcd'
import { createTcpTransport } from '@delali/narsil/distribution/transport/tcp'
import { createServer } from '@delali/narsil/server'
import { ETCD_ENDPOINT, nodeSpecOf, PARTITION_COUNT, REPLICATION_FACTOR } from './topology.js'

const nodeId = process.env.NODE_ID ?? 'node-a'
const spec = nodeSpecOf(nodeId)
const certDir = process.env.CERT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'certs')

const coordinator = await createEtcdCoordinator({
  endpoints: [process.env.ETCD_ENDPOINT ?? ETCD_ENDPOINT],
  keyPrefix: '_narsil_example',
  nodeHeartbeatTtlSeconds: 5,
  leaseTtlSeconds: 5,
})

const transport = createTcpTransport(nodeId, {
  host: '127.0.0.1',
  port: spec.tcpPort,
  tls: {
    cert: readFileSync(join(certDir, `${nodeId}.crt`)),
    key: readFileSync(join(certDir, `${nodeId}.key`)),
    ca: readFileSync(join(certDir, 'ca.crt')),
  },
})

const node = await createClusterNode({
  coordinator,
  transport,
  address: `127.0.0.1:${spec.tcpPort}`,
  nodeId,
  roles: ['data', 'coordinator', 'controller'],
  onError: error => console.error(`[${nodeId}] ${error.message}`),
})

await node.start()

const server = createServer(
  clusterNodeEngine(node, {
    createIndex: { partitionCount: PARTITION_COUNT, replicationFactor: REPLICATION_FACTOR },
  }),
  { host: '127.0.0.1', port: spec.httpPort },
)
await server.listen()

console.log(`[${nodeId}] serving HTTP on 127.0.0.1:${spec.httpPort}, TCP on 127.0.0.1:${spec.tcpPort}`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await server.close()
  await node.shutdown()
  await transport.shutdown()
  await coordinator.shutdown()
  process.exit(0)
}

process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
