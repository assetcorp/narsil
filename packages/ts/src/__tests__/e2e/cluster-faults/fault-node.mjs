import { createFilesystemPersistence } from '../../../../dist/adapters/filesystem.mjs'
import { createEtcdCoordinator } from '../../../../dist/distribution/coordinator/etcd.mjs'
import { createGrpcTransport } from '../../../../dist/distribution/transport/grpc.mjs'
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
const transportConfig = {
  host: '127.0.0.1',
  port: settings.transportPort,
  ...(settings.transportTls === undefined ? {} : { tls: settings.transportTls }),
}
const transport =
  settings.transport === 'grpc'
    ? await createGrpcTransport('fault-node', transportConfig)
    : createTcpTransport('fault-node', transportConfig)
const node = await createClusterNode({
  coordinator,
  transport,
  address: `127.0.0.1:${settings.advertisedPort}`,
  ...(settings.nodeId === undefined ? {} : { nodeId: settings.nodeId }),
  roles: settings.roles ?? ['data', 'coordinator', 'controller'],
  engine: { workers: { enabled: false }, durability: { directory: settings.directory } },
  controller: {
    leaseTtlMs: settings.controllerLeaseTtlMs,
    standbyRetryMs: settings.standbyRetryMs,
    ...(settings.nodeLeftDelayMs === undefined ? {} : { nodeLeftDelayMs: settings.nodeLeftDelayMs }),
  },
  ...(settings.backupDirectory === undefined
    ? {}
    : {
        backups: {
          store: createFilesystemPersistence({ directory: settings.backupDirectory }),
          keyPrefix: settings.backupKeyPrefix,
        },
      }),
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

const SOCKET_RESOURCE_TYPES = new Set(['TCPSocketWrap', 'TCPServerWrap', 'TLSWrap'])
const SOCKET_CLOSE_GRACE_MS = 3_000
const SOCKET_POLL_MS = 100

function openSockets() {
  return process.getActiveResourcesInfo().filter(type => SOCKET_RESOURCE_TYPES.has(type))
}

const etcdPorts = new Set((settings.etcdEndpoints ?? []).map(endpoint => Number(new URL(endpoint).port)))

function describeHandle(handle) {
  if (typeof handle?.address === 'function' && typeof handle?.listening === 'boolean') {
    const port = handle.address()?.port
    if (port === settings.httpPort) return 'the HTTP listener'
    if (port === settings.transportPort) return 'the transport listener'
    return `a listener on port ${port}`
  }
  if (typeof handle?.localPort !== 'number' && typeof handle?.remotePort !== 'number') return null
  if (handle.localPort === settings.httpPort) return `an inbound HTTP socket from port ${handle.remotePort}`
  if (handle.localPort === settings.transportPort) return `an inbound transport socket from port ${handle.remotePort}`
  if (etcdPorts.has(handle.remotePort)) return `an etcd socket to port ${handle.remotePort}`
  return `an outbound socket to port ${handle.remotePort}`
}

function labelledSockets() {
  return process
    ._getActiveHandles()
    .map(describeHandle)
    .filter(label => label !== null)
}

async function socketsLeftOpen() {
  const deadline = Date.now() + SOCKET_CLOSE_GRACE_MS
  while (openSockets().length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SOCKET_POLL_MS))
  }
  return openSockets()
}

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.close()
  await node.shutdown()
  await transport.shutdown()
  await coordinator.shutdown()
  if (process.env.NARSIL_FAULT_CAMPAIGN === '1') {
    const left = await socketsLeftOpen()
    if (left.length > 0)
      process.stderr.write(`SOCKETS LEFT OPEN AT SHUTDOWN: ${left.join(', ')}; ${labelledSockets().join(', ')}\n`)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
