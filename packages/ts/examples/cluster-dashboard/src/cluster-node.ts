import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clusterNodeEngine, createClusterNode } from '@delali/narsil/distribution'
import { createEtcdCoordinator } from '@delali/narsil/distribution/coordinator/etcd'
import { createTcpTransport } from '@delali/narsil/distribution/transport/tcp'
import { createServer } from '@delali/narsil/server'
import {
  advertisedAddressOf,
  CONTROLLER_LEASE_TTL_SECONDS,
  ETCD_KEY_PREFIX,
  NODE_HEARTBEAT_TTL_SECONDS,
  nodeSpecOf,
  PARTITION_COUNT,
  REPLICATION_FACTOR,
} from './topology'

const MILLISECONDS_PER_SECOND = 1_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} is required`)
  }
  return value
}

const spec = nodeSpecOf(requireEnv('NODE_ID'))
const certDir = process.env.CERT_DIR ?? '/certs'
const listenHost = process.env.LISTEN_HOST ?? '0.0.0.0'

const coordinator = await createEtcdCoordinator({
  endpoints: [requireEnv('ETCD_ENDPOINT')],
  keyPrefix: ETCD_KEY_PREFIX,
  nodeHeartbeatTtlSeconds: NODE_HEARTBEAT_TTL_SECONDS,
})

const transport = createTcpTransport(spec.nodeId, {
  host: listenHost,
  port: spec.replicationPort,
  tls: {
    cert: readFileSync(join(certDir, `${spec.nodeId}.crt`)),
    key: readFileSync(join(certDir, `${spec.nodeId}.key`)),
    ca: readFileSync(join(certDir, 'ca.crt')),
  },
})

const node = await createClusterNode({
  coordinator,
  transport,
  address: advertisedAddressOf(spec),
  nodeId: spec.nodeId,
  roles: ['data', 'coordinator', 'controller'],
  controller: { leaseTtlMs: CONTROLLER_LEASE_TTL_SECONDS * MILLISECONDS_PER_SECOND },
  onError: error => console.error(`[${spec.nodeId}] ${error.message}`),
})

await node.start()

const server = createServer(
  clusterNodeEngine(node, {
    createIndex: { partitionCount: PARTITION_COUNT, replicationFactor: REPLICATION_FACTOR },
  }),
  { host: listenHost, port: spec.httpPort, allowInsecure: true, cluster: node.cluster },
)
await server.listen()

console.log(
  `[${spec.nodeId}] HTTP on ${listenHost}:${spec.httpPort}, replication on ${listenHost}:${spec.replicationPort}, advertised as ${advertisedAddressOf(spec)}`,
)

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
